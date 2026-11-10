import { Hono } from 'hono';
import type { Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Config } from './config.ts';
import type { Db } from './db/driver.ts';
import type { Logger } from './logger.ts';
import { AppError } from '../shared/errors.ts';
import type { ErrorBody } from '../shared/errors.ts';
import { RateLimiter } from './auth/rateLimit.ts';
import type { AuthContext } from './auth/session.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { fileRoutes } from './routes/files.ts';
import { pageRoutes, trashRoutes } from './routes/pages.ts';
import { staticRoutes } from './static.ts';
import { requestBodyLimit } from './routes/validate.ts';
import { searchRoutes } from './routes/search.ts';
import { databaseRoutes, rowRoutes } from './routes/databases.ts';
import { annotationRoutes } from './routes/annotations.ts';
import { offlineRoutes } from './routes/offline.ts';
import { pageShareRoutes, shareRoutes } from './routes/shares.ts';
import { publicRoutes } from './routes/public.ts';
import { versionInfo } from './releases.ts';

export interface AppDeps {
  db: Db;
  config: Config;
  logger: Logger;
  now: () => number;
  rateLimiter: RateLimiter;
  /** Directory with the built client (dist/client); omitted in tests. */
  clientDir?: string;
}

export type AppEnv = { Variables: { deps: AppDeps; auth?: AuthContext } };

/** Credentials and profile fields only. */
const MAX_AUTH_BODY_BYTES = 64 * 1024;
/** Page content is capped at 2M UTF-16 units (shared/blocks.ts), which is at most ~6 MB of UTF-8 plus JSON framing. */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

/** A file served through a public link: like `/api/files/`, it sets its own headers. */
const PUBLIC_FILE = /^\/api\/public\/[^/]+\/files\//;
/** The token in a public address is a credential: it never goes into a log line. */
export const maskPath = (path: string): string => path.replace(/^\/(api\/public|s)\/[^/]+/, '/$1/…');

export function errorBody(error: AppError): ErrorBody {
  return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

export function createApp(input: Omit<AppDeps, 'now' | 'rateLimiter'> & Partial<Pick<AppDeps, 'now' | 'rateLimiter'>>): Hono<AppEnv> {
  const deps: AppDeps = { now: () => Date.now(), rateLimiter: new RateLimiter(), ...input };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  // File downloads set their own headers (inline media must not inherit the page CSP; attachments get `sandbox`).
  const secure = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'no-referrer',
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    xFrameOptions: 'DENY',
  });
  const servesFile = (path: string, method: string) => (path.startsWith('/api/files/') && method !== 'POST') || PUBLIC_FILE.test(path);
  app.use('*', async (c, next) => servesFile(c.req.path, c.req.method) ? next() : secure(c, next));
  app.use('/api/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  // Nothing is read into memory beyond these sizes. Uploads get their own (authenticated) limit in the files route.
  const authBody = requestBodyLimit(MAX_AUTH_BODY_BYTES), jsonBody = requestBodyLimit(MAX_JSON_BODY_BYTES);
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && /^\/api\/files\/?$/.test(c.req.path)) return next();
    return (c.req.path.startsWith('/api/auth/') ? authBody : jsonBody)(c, next);
  });

  app.route('/', healthRoutes());
  app.get('/api/version', c => c.json(versionInfo(deps.config.version)));
  app.route('/api/auth', authRoutes());
  app.route('/api/admin', adminRoutes());
  app.route('/api/pages', pageRoutes());
  app.route('/api/pages', annotationRoutes());
  app.route('/api/pages', pageShareRoutes());
  app.route('/api/shares', shareRoutes());
  app.route('/api/public', publicRoutes());
  app.route('/api/trash', trashRoutes());
  app.route('/api/files', fileRoutes());
  app.route('/api/search', searchRoutes());
  app.route('/api/databases', databaseRoutes());
  app.route('/api/rows', rowRoutes());
  app.route('/api/offline', offlineRoutes());

  app.notFound(c => c.req.path.startsWith('/api/')
    ? c.json(errorBody(new AppError('not_found')), 404)
    : c.text('Not Found', 404));
  app.onError((error, c: Context<AppEnv>) => {
    if (error instanceof AppError) {
      if (error.code === 'rate_limited' && typeof error.details?.retryAfterSeconds === 'number') c.header('Retry-After', String(error.details.retryAfterSeconds));
      return c.json(errorBody(error), error.status as 400);
    }
    deps.logger.error('unhandled error', { path: maskPath(c.req.path), message: error instanceof Error ? error.message : String(error) });
    return c.json(errorBody(new AppError('internal')), 500);
  });

  if (deps.clientDir) app.route('/', staticRoutes(deps.clientDir));
  return app;
}
