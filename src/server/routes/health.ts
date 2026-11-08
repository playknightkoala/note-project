import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';

/** Public liveness check: a trivial read against the database, no writes, no auth. */
export function healthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/healthz', c => {
    try {
      c.get('deps').db.get('SELECT 1 AS ok');
      return c.text('ok\n', 200, { 'Cache-Control': 'no-store' });
    } catch {
      return c.text('database unavailable\n', 503, { 'Cache-Control': 'no-store' });
    }
  });
  return app;
}
