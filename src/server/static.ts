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
  app.use('/sw.js', async (c, next) => { c.header('Cache-Control', 'no-cache'); c.header('Service-Worker-Allowed', '/'); await next(); });
  app.use('*', serveStatic({ root: clientDir, index: '__none__' }));
  app.get('*', c => {
    // A missing hashed asset is an error, never the app shell: a 200 HTML answer would be cached as that asset.
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) return c.notFound();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method Not Allowed', 405);
    // A public link is for whoever was given it, not for search engines.
    return c.html(index, 200, { 'Cache-Control': 'no-cache', ...(c.req.path.startsWith('/s/') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) });
  });
  return app;
}
