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
import { clientIp, requireAuth, requireCsrf, requireSameOrigin } from '../auth/middleware.ts';
import { ABSOLUTE_TTL_MS, SESSION_COOKIE, createSession, deleteSession, deleteUserSessions, userDto } from '../auth/session.ts';
import { countUsers, findUserByIdentifier, insertUser } from '../services/users.ts';
import { parseBody } from './validate.ts';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_PER_IP = 10;
const LOGIN_PER_PAIR = 5;
const LOGIN_PER_ACCOUNT = 30;

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
    if (!user || !ok) throw new AppError('unauthorized', '帳號或密碼錯誤。');
    if (user.disabled_at !== null) throw new AppError('account_disabled');
    if (needsRehash(user.password_hash)) deps.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(input.password), now, user.id);
    deps.rateLimiter.clear(pairKey);
    deps.rateLimiter.clear(idKey);
    const csrfToken = issueSession(c, user.id);
    return c.json<SessionDto>({ user: userDto(user), csrfToken });
  });

  app.use('/logout', requireAuth, requireCsrf);
  app.post('/logout', c => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(c.get('deps').db, token);
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
    const auth = c.get('auth')!;
    const input = await parseBody(c, passwordChangeSchema);
    if (!await verifyPassword(auth.user.password_hash, input.currentPassword)) throw new AppError('bad_request', '目前密碼不正確。');
    deps.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(input.newPassword), deps.now(), auth.user.id);
    deleteUserSessions(deps.db, auth.user.id, getCookie(c, SESSION_COOKIE));
    return c.body(null, 204);
  });

  app.use('/profile', requireAuth, requireCsrf);
  app.patch('/profile', async c => {
    const deps = c.get('deps');
    const auth = c.get('auth')!;
    const input = await parseBody(c, profileUpdateSchema);
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
