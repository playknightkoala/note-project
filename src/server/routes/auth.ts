import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app.ts';
import { loginSchema, passwordChangeSchema, profileUpdateSchema, registerSchema } from '../../shared/api.ts';
import type { AuthStatusDto, SessionDto } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '../auth/password.ts';
import { inviteUsable, redeemInvite } from '../auth/invites.ts';
import { clientIp, refreshAuth, requireAuth, requireCsrf, requireSameOrigin } from '../auth/middleware.ts';
import { ABSOLUTE_TTL_MS, SESSION_COOKIE, createSession, deleteSession, deleteUserSessions, userDto } from '../auth/session.ts';
import { countUsers, findUserById, findUserByIdentifier, insertUser } from '../services/users.ts';
import { parseBody } from './validate.ts';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_PER_IP = 10;
const LOGIN_PER_PAIR = 5;
const LOGIN_PER_ACCOUNT = 30;
/** Wrong guesses at the current password by somebody who holds a session, per account. */
const PASSWORD_CHANGE_ATTEMPTS = 5;

function secretEquals(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieSecure(c: Context<AppEnv>): boolean {
  const { config } = c.get('deps');
  if (config.cookieSecure !== 'auto') return config.cookieSecure;
  return config.trustProxy ? c.req.header('x-forwarded-proto') === 'https' : new URL(c.req.url).protocol === 'https:';
}

function issueSession(c: Context<AppEnv>, userId: string): string {
  const deps = c.get('deps');
  const { token, csrfToken } = createSession(deps.db, userId, deps.now(), { userAgent: c.req.header('user-agent'), ip: clientIp(c) });
  // The cookie outlives the 30-day idle window so a sliding session is not cut short by the browser; the DB decides.
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: cookieSecure(c), maxAge: Math.floor(ABSOLUTE_TTL_MS / 1000) });
  return csrfToken;
}

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/status', c => {
    const { db, config } = c.get('deps');
    const setupRequired = countUsers(db) === 0;
    return c.json<AuthStatusDto>({ setupRequired, ...(setupRequired && config.setupToken ? { setupTokenRequired: true } : {}) });
  });

  app.use('/register', requireSameOrigin);
  app.post('/register', async c => {
    const deps = c.get('deps');
    const now = deps.now();
    const ip = clientIp(c);
    const limited = deps.rateLimiter.hit(`register:${ip}`, 5, 60 * 60 * 1000, now);
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    const input = await parseBody(c, registerSchema);
    // The invite (or setup token) is checked before anything else, so a caller without one learns nothing about
    // which emails exist and cannot make the server spend a password hash.
    const admit = (): boolean => {
      const first = countUsers(deps.db) === 0;
      if (first) {
        if (deps.config.setupToken && !secretEquals(input.inviteCode ?? '', deps.config.setupToken)) throw new AppError('invite_invalid', '需要設定碼才能建立管理者帳號。');
      } else {
        if (!input.inviteCode) throw new AppError('invite_invalid', '註冊需要邀請碼。');
        if (!inviteUsable(deps.db, input.inviteCode, now)) throw new AppError('invite_invalid');
      }
      return first;
    };
    admit();
    const passwordHash = await hashPassword(input.password);
    const user = deps.db.transaction(() => {
      const first = admit();
      const created = insertUser(deps.db, { email: input.email, username: input.username ?? null, displayName: input.displayName,
        passwordHash, role: first ? 'admin' : 'user' }, now);
      if (!first) redeemInvite(deps.db, input.inviteCode!, created.id, now);
      return created;
    });
    deps.logger.info('user registered', { userId: user.id, role: user.role });
    const csrfToken = issueSession(c, user.id);
    return c.json<SessionDto>({ user: userDto(user), csrfToken }, 201);
  });

  app.use('/login', requireSameOrigin);
  app.post('/login', async c => {
    const deps = c.get('deps');
    const now = deps.now();
    const ip = clientIp(c);
    const limit = (key: string, max: number) => {
      const result = deps.rateLimiter.hit(key, max, LOGIN_WINDOW_MS, now);
      if (!result.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: result.retryAfterSeconds });
    };
    // Per address first, before the body is even read.
    limit(`login:ip:${ip}`, LOGIN_PER_IP);
    const input = await parseBody(c, loginSchema);
    const identifier = input.identifier.trim().toLowerCase();
    // The strict limit is per (address, account): someone else's failed guesses must not lock the real owner out.
    // The per-account limit is a much higher backstop against guessing spread over many addresses.
    const pairKey = `login:pair:${ip}:${identifier}`, idKey = `login:id:${identifier}`;
    limit(pairKey, LOGIN_PER_PAIR);
    limit(idKey, LOGIN_PER_ACCOUNT);
    const user = findUserByIdentifier(deps.db, identifier);
    const ok = user ? await verifyPassword(user.password_hash, input.password) : (await dummyVerify(input.password), false);
    // The identifier is never logged: a password typed into the wrong field would end up in the log.
    if (!user || !ok) { deps.logger.warn('login failed', { ip, ...(user ? { userId: user.id } : {}) }); throw new AppError('unauthorized', '帳號或密碼錯誤。'); }
    if (user.disabled_at !== null) { deps.logger.warn('login refused: account disabled', { ip, userId: user.id }); throw new AppError('account_disabled'); }
    const refuse = (): never => { deps.logger.warn('login failed', { ip, userId: user.id }); throw new AppError('unauthorized', '帳號或密碼錯誤。'); };
    let verified = user.password_hash;
    let rehashed = needsRehash(verified) ? await hashPassword(input.password) : undefined;
    // Verifying (and re-hashing) took time. The session is only issued if, now, the account still has the hash that
    // was verified and is not disabled: a password change that signed every session out in the meantime must not be
    // followed by a new session for the old password. A hash that differs is not a refusal by itself (another
    // sign-in may just have upgraded it): the password is verified against it, and the check is made again.
    const settle = () => deps.db.transaction((): { csrfToken: string } | { changed: string } => {
      const current = findUserById(deps.db, user.id);
      if (!current) return refuse();
      if (current.password_hash !== verified) return { changed: current.password_hash };
      if (current.disabled_at !== null) { deps.logger.warn('login refused: account disabled', { ip, userId: user.id }); throw new AppError('account_disabled'); }
      if (rehashed) deps.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', rehashed, now, user.id);
      return { csrfToken: issueSession(c, user.id) };
    });
    let outcome = settle();
    for (let attempt = 0; 'changed' in outcome; attempt++) {
      if (attempt >= 2 || !await verifyPassword(outcome.changed, input.password)) return refuse();
      verified = outcome.changed; rehashed = undefined;
      outcome = settle();
    }
    const { csrfToken } = outcome;
    deps.rateLimiter.clear(pairKey);
    deps.rateLimiter.clear(idKey);
    deps.logger.info('login', { ip, userId: user.id });
    return c.json<SessionDto>({ user: userDto(user), csrfToken });
  });

  app.use('/logout', requireAuth, requireCsrf);
  app.post('/logout', c => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(c.get('deps').db, token);
    c.get('deps').logger.info('logout', { userId: c.get('auth')!.user.id });
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/me', requireAuth, c => {
    const auth = c.get('auth')!;
    return c.json<SessionDto>({ user: userDto(auth.user), csrfToken: auth.session.csrf_token });
  });

  app.use('/password', requireAuth, requireCsrf);
  app.post('/password', async c => {
    const deps = c.get('deps');
    const userId = c.get('auth')!.user.id;
    // Holding a session must not be a way to try passwords without limit.
    const limitKey = `password:${userId}`;
    const limited = deps.rateLimiter.hit(limitKey, PASSWORD_CHANGE_ATTEMPTS, LOGIN_WINDOW_MS, deps.now());
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    const input = await parseBody(c, passwordChangeSchema);
    // The hash as it is once the body has arrived, not as it was when the request started.
    const verified = c.get('auth')!.user.password_hash;
    if (!await verifyPassword(verified, input.currentPassword)) {
      deps.logger.warn('password change refused: wrong current password', { userId });
      throw new AppError('bad_request', '目前密碼不正確。');
    }
    const passwordHash = await hashPassword(input.newPassword);
    deps.db.transaction(() => {
      // Hashing took time as well. The session must still stand and the password must still be the one that was
      // verified: otherwise this request was overtaken by a sign-out or by another password change.
      const auth = refreshAuth(c)!;
      if (auth.user.password_hash !== verified) throw new AppError('conflict', '密碼已在其他地方變更，請重新登入後再試。');
      deps.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, deps.now(), userId);
      deleteUserSessions(deps.db, userId, getCookie(c, SESSION_COOKIE));
    });
    deps.rateLimiter.clear(limitKey);
    deps.logger.info('password changed', { userId });
    return c.body(null, 204);
  });

  app.use('/profile', requireAuth, requireCsrf);
  app.patch('/profile', async c => {
    const deps = c.get('deps');
    const input = await parseBody(c, profileUpdateSchema);
    const auth = c.get('auth')!;
    const displayName = input.displayName ?? auth.user.display_name;
    const username = input.username === undefined ? auth.user.username : input.username;
    try {
      deps.db.run('UPDATE users SET display_name = ?, username = ?, updated_at = ? WHERE id = ?', displayName, username, deps.now(), auth.user.id);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppError('conflict', '使用者名稱已被使用。');
      throw error;
    }
    return c.json<SessionDto>({ user: userDto({ ...auth.user, display_name: displayName, username }), csrfToken: auth.session.csrf_token });
  });

  return app;
}
