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
import { staticRoutes } from './static.ts';

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

export function errorBody(error: AppError): ErrorBody {
  return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

export function createApp(input: Omit<AppDeps, 'now' | 'rateLimiter'> & Partial<Pick<AppDeps, 'now' | 'rateLimiter'>>): Hono<AppEnv> {
  const deps: AppDeps = { now: () => Date.now(), rateLimiter: new RateLimiter(), ...input };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.use('*', secureHeaders({
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
  }));
  app.use('/api/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

  app.route('/', healthRoutes());
  app.get('/api/version', c => c.json({ version: deps.config.version }));
  app.route('/api/auth', authRoutes());
  app.route('/api/admin', adminRoutes());

  app.notFound(c => c.req.path.startsWith('/api/')
    ? c.json(errorBody(new AppError('not_found')), 404)
    : c.text('Not Found', 404));
  app.onError((error, c: Context<AppEnv>) => {
    if (error instanceof AppError) {
      if (error.code === 'rate_limited' && typeof error.details?.retryAfterSeconds === 'number') c.header('Retry-After', String(error.details.retryAfterSeconds));
      return c.json(errorBody(error), error.status as 400);
    }
    deps.logger.error('unhandled error', { path: c.req.path, message: error instanceof Error ? error.message : String(error) });
    return c.json(errorBody(new AppError('internal')), 500);
  });

  if (deps.clientDir) app.route('/', staticRoutes(deps.clientDir));
  return app;
}
