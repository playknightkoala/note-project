import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { contentSchema, createPageSchema, favoriteSchema, movePageSchema, patchPageSchema } from '../../shared/api.ts';
import type { PageResponse, TreeDto } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import * as pages from '../services/pages.ts';
import { parseBody } from './validate.ts';

/** `If-Match: "<version>"` is required for content writes so two tabs never overwrite each other silently. */
export function expectedVersion(c: Context<AppEnv>): number {
  const header = c.req.header('if-match');
  if (!header) throw new AppError('precondition_required');
  const version = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(version) || version < 0) throw new AppError('bad_request', 'If-Match 格式不正確。');
  return version;
}

export function pageRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  const ctx = (c: Context<AppEnv>) => ({ db: c.get('deps').db, userId: c.get('auth')!.user.id, now: c.get('deps').now() });

  app.get('/tree', c => { const { db, userId } = ctx(c); return c.json<TreeDto>({ pages: pages.listTree(db, userId) }); });

  app.post('/', async c => {
    const { db, userId, now } = ctx(c);
    const input = await parseBody(c, createPageSchema);
    const row = pages.createPage(db, userId, { parentId: input.parentId ?? null, kind: input.kind, title: input.title, afterId: input.afterId ?? null, icon: input.icon ?? null }, now);
    return c.json<PageResponse>({ page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) }, 201);
  });

  app.get('/:id', c => {
    const { db, userId } = ctx(c);
    const row = pages.loadPage(db, userId, c.req.param('id'), { allowTrashed: true });
    c.header('ETag', `"${row.version}"`);
    return c.json<PageResponse>({ page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) });
  });

  app.get('/:id/head', c => { const { db, userId } = ctx(c); return c.json(pages.headOf(pages.loadPage(db, userId, c.req.param('id')))); });

  app.put('/:id/content', async c => {
    const { db, userId, now } = ctx(c);
    const version = expectedVersion(c);
    const input = await parseBody(c, contentSchema);
    return c.json(pages.updateContent(db, userId, c.req.param('id'), input.content, version, now));
  });

  app.patch('/:id', async c => {
    const { db, userId, now } = ctx(c);
    const input = await parseBody(c, patchPageSchema);
    const row = pages.patchPage(db, userId, c.req.param('id'), input, now);
    return c.json<PageResponse>({ page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) });
  });

  app.post('/:id/move', async c => {
    const { db, userId, now } = ctx(c);
    const input = await parseBody(c, movePageSchema);
    return c.json({ page: pages.toPageDto(pages.movePage(db, userId, c.req.param('id'), input.parentId, input.index, now)) });
  });

  app.post('/:id/favorite', async c => {
    const { db, userId, now } = ctx(c);
    const input = await parseBody(c, favoriteSchema);
    return c.json({ page: pages.toPageDto(pages.setFavorite(db, userId, c.req.param('id'), input.favorite, now)) });
  });

  app.post('/:id/duplicate', c => {
    const { db, userId, now } = ctx(c);
    const row = pages.duplicatePage(db, userId, c.req.param('id'), now);
    return c.json<PageResponse>({ page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) }, 201);
  });

  app.delete('/:id', c => { const { db, userId, now } = ctx(c); return c.json({ trashedCount: pages.trashPage(db, userId, c.req.param('id'), now) }); });

  app.get('/:id/versions', c => { const { db, userId } = ctx(c); return c.json({ versions: pages.listVersions(db, userId, c.req.param('id')) }); });
  app.get('/:id/versions/:vid', c => { const { db, userId } = ctx(c); return c.json(pages.getVersion(db, userId, c.req.param('id'), c.req.param('vid'))); });
  app.post('/:id/versions/:vid/restore', c => {
    const { db, userId, now } = ctx(c);
    return c.json(pages.restoreVersion(db, userId, c.req.param('id'), c.req.param('vid'), expectedVersion(c), now));
  });

  return app;
}

export function trashRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  const ctx = (c: Context<AppEnv>) => ({ db: c.get('deps').db, userId: c.get('auth')!.user.id, now: c.get('deps').now() });
  app.get('/', c => { const { db, userId } = ctx(c); return c.json({ items: pages.listTrash(db, userId) }); });
  app.delete('/', c => { const { db, userId } = ctx(c); return c.json({ deleted: pages.emptyTrash(db, userId) }); });
  app.post('/:id/restore', c => { const { db, userId, now } = ctx(c); return c.json({ page: pages.toPageDto(pages.restorePage(db, userId, c.req.param('id'), now)) }); });
  app.delete('/:id', c => { const { db, userId } = ctx(c); pages.deleteTrashed(db, userId, c.req.param('id')); return c.body(null, 204); });
  return app;
}
