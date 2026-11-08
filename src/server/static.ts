import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv } from './app.ts';

/** Serves the built SPA: hashed assets immutable, everything else falls back to index.html (no-cache). */
export function staticRoutes(clientDir: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const index = readFileSync(join(clientDir, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); await next(); });
  app.use('*', serveStatic({ root: clientDir, index: '__none__' }));
  app.get('*', c => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method Not Allowed', 405);
    return c.html(index, 200, { 'Cache-Control': 'no-cache' });
  });
  return app;
}
