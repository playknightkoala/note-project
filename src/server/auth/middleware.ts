import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { SESSION_COOKIE, loadSession } from './session.ts';

/**
 * Client IP for rate limiting. Behind a trusted proxy: the configured CLIENT_IP_HEADER, otherwise the LAST
 * X-Forwarded-For hop. Earlier hops are whatever the client sent, so they must never be used as the key.
 */
export function clientIp(c: Context<AppEnv>): string {
  const { config } = c.get('deps');
  if (config.trustProxy) {
    const named = config.clientIpHeader ? c.req.header(config.clientIpHeader)?.trim() : undefined;
    if (named) return named.slice(0, 64);
    const forwarded = c.req.header('x-forwarded-for')?.split(',').map(hop => hop.trim()).filter(Boolean).at(-1);
    if (forwarded) return forwarded.slice(0, 64);
  }
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
}

/** The host this server believes it is serving (behind a trusted proxy: the forwarded host), for the Origin check. */
export function requestHost(c: Context<AppEnv>): string | null {
  const { config } = c.get('deps');
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  return (forwarded || c.req.header('host') || new URL(c.req.url).host || null)?.toLowerCase() ?? null;
}

/**
 * Same-origin check for mutations. The Origin header must name the configured PUBLIC_ORIGIN or the host this request
 * arrived on; the scheme is deliberately ignored so a TLS-terminating proxy that does not forward the protocol
 * cannot break every write (an attacker's page still fails: its host differs).
 */
export function originAllowed(c: Context<AppEnv>, origin: string): boolean {
  const { config } = c.get('deps');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (config.publicOrigin && origin.toLowerCase() === config.publicOrigin.toLowerCase()) return true;
  const host = requestHost(c);
  return host !== null && parsed.host.toLowerCase() === host;
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

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function assertSameOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header('origin');
  if (origin === 'null') throw new AppError('csrf');
  if (origin && !originAllowed(c, origin)) throw new AppError('csrf', '請求來源與網站不符；若網站在反向代理後面，請設定 NOTES_PUBLIC_ORIGIN。');
}

/**
 * For the endpoints that run before a session exists (login, register): a cross-site page must not be able to sign
 * the visitor into an account of the attacker's choosing.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.includes(c.req.method)) assertSameOrigin(c);
  await next();
};

/** Every state-changing request must carry the session's CSRF token and, when present, a same-origin Origin header. */
export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.includes(c.req.method)) { await next(); return; }
  assertSameOrigin(c);
  const auth = c.get('auth');
  const header = c.req.header('x-csrf-token') ?? '';
  if (!auth || header.length !== auth.session.csrf_token.length || !timingSafeEqual(Buffer.from(header), Buffer.from(auth.session.csrf_token))) throw new AppError('csrf');
  await next();
};
