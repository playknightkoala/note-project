import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { propertyInputSchema, propertyPatchSchema, rowInputSchema, rowsQuerySchema, viewConfigSchema, viewInputSchema } from '../../shared/database.ts';
import { AppError } from '../../shared/errors.ts';
import { parseBody, parseValue } from './validate.ts';
import { expectedVersion } from './pages.ts';
import * as databases from '../services/databases.ts';

function context(c: Context<AppEnv>) { return { db: c.get('deps').db, userId: c.get('auth')!.user.id, now: c.get('deps').now() }; }
function queryJson(value: string | undefined): unknown {
  if (value === undefined) return [];
  try { return JSON.parse(value); } catch { throw new AppError('bad_request', '排序或篩選格式不正確。'); }
}
export function databaseRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/:id', c => { const { db, userId } = context(c); return c.json(databases.getDatabase(db, userId, c.req.param('id'))); });
  app.post('/:id/properties', async c => {
    const { db, userId, now } = context(c); const input = await parseBody(c, propertyInputSchema);
    return c.json(databases.addProperty(db, userId, c.req.param('id'), input, expectedVersion(c), now), 201);
  });
  app.patch('/:id/properties/:pid', async c => {
    const { db, userId, now } = context(c); const input = await parseBody(c, propertyPatchSchema);
    return c.json(databases.updateProperty(db, userId, c.req.param('id'), c.req.param('pid'), input, expectedVersion(c), now));
  });
  app.delete('/:id/properties/:pid', c => {
    const { db, userId, now } = context(c);
    return c.json(databases.deleteProperty(db, userId, c.req.param('id'), c.req.param('pid'), expectedVersion(c), now));
  });
  app.patch('/:id/views/:vid', async c => {
    const { db, userId, now } = context(c); const input = await parseBody(c, viewInputSchema);
    return c.json(databases.updateView(db, userId, c.req.param('id'), c.req.param('vid'), input, expectedVersion(c), now));
  });
  app.get('/:id/rows', c => {
    const { db, userId } = context(c); const query = parseValue(c.req.query(), rowsQuerySchema);
    const config = parseValue({ sorts: queryJson(query.sort), filters: queryJson(query.filter) }, viewConfigSchema);
    return c.json(databases.listRows(db, userId, c.req.param('id'), config, query.offset, query.limit));
  });
  app.post('/:id/rows', async c => {
    const { db, userId, now } = context(c); const input = await parseBody(c, rowInputSchema);
    return c.json(databases.addRow(db, userId, c.req.param('id'), input, expectedVersion(c), now), 201);
  });
  return app;
}
export function rowRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/:id', c => { const { db, userId } = context(c); return c.json(databases.getRow(db, userId, c.req.param('id'))); });
  app.patch('/:id/values', async c => {
    const { db, userId, now } = context(c); const input = await parseBody(c, rowInputSchema);
    return c.json(databases.updateRow(db, userId, c.req.param('id'), input, expectedVersion(c), now));
  });
  return app;
}
