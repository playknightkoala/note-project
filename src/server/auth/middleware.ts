import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { SESSION_COOKIE, loadSession } from './session.ts';

/** Client IP for rate limiting: the first X-Forwarded-For hop only when a trusted proxy is configured. */
export function clientIp(c: Context<AppEnv>): string {
  const { config } = c.get('deps');
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}

/** The origin this server believes it is serving, for the Origin check. */
export function requestOrigin(c: Context<AppEnv>): string | null {
  const { config } = c.get('deps');
  if (config.publicOrigin) return config.publicOrigin;
  const url = new URL(c.req.url);
  const host = c.req.header('host') ?? url.host;
  if (!host) return null;
  const proto = config.trustProxy && c.req.header('x-forwarded-proto') === 'https' ? 'https' : url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get('deps');
  const auth = loadSession(deps.db, getCookie(c, SESSION_COOKIE), (deps.now ?? Date.now)());
  if (!auth) throw new AppError('unauthorized');
  if (auth.user.disabled_at !== null) throw new AppError('account_disabled');
  c.set('auth', auth);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth')?.user.role !== 'admin') throw new AppError('forbidden');
  await next();
};

/** Every state-changing request must carry the session's CSRF token and, when present, a same-origin Origin header. */
export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) { await next(); return; }
  const origin = c.req.header('origin');
  const expected = requestOrigin(c);
  if (origin && (!expected || origin !== expected)) throw new AppError('csrf');
  const auth = c.get('auth');
  const header = c.req.header('x-csrf-token') ?? '';
  if (!auth || header.length !== auth.session.csrf_token.length || !timingSafeEqual(Buffer.from(header), Buffer.from(auth.session.csrf_token))) throw new AppError('csrf');
  await next();
};
