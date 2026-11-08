import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { searchQuerySchema } from '../../shared/api.ts';
import { searchPages } from '../services/search.ts';
import { parseValue } from './validate.ts';

export function searchRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  app.get('/', c => {
    const { q, limit, offset } = parseValue(c.req.query(), searchQuerySchema);
    return c.json(searchPages(c.get('deps').db, c.get('auth')!.user.id, q, limit, offset));
  });
  return app;
}
