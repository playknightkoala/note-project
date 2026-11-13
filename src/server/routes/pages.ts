import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { contentSchema, createPageSchema, favoriteSchema, movePageSchema, patchPageSchema } from '../../shared/api.ts';
import type { PageResponse, TreeDto } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import * as pages from '../services/pages.ts';
import { pageResponse, requireAccess } from '../services/access.ts';
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

  // The four routes below also serve members of a share: access is resolved first, then the page is read as its owner.
  app.get('/:id', c => {
    const { db, userId } = ctx(c);
    const access = requireAccess(db, userId, c.req.param('id'), 'view');
    // Only the owner may open a page that is in the trash.
    const row = pages.loadPage(db, access.ownerId, c.req.param('id'), { allowTrashed: access.role === 'owner' });
    c.header('ETag', `"${row.version}"`);
    return c.json<PageResponse>(pageResponse(db, access, row));
  });

  app.get('/:id/head', c => {
    const { db, userId } = ctx(c);
    return c.json(pages.headOf(pages.loadPage(db, requireAccess(db, userId, c.req.param('id'), 'view').ownerId, c.req.param('id'))));
  });

  // A member's right to write is settled twice: before the body is read, so a stranger is answered "not found"
  // whatever they send, and again once it has arrived, because a share can end while a body is on its way.
  app.put('/:id/content', async c => {
    const { db, userId, now } = ctx(c);
    const id = c.req.param('id');
    const version = expectedVersion(c);
    requireAccess(db, userId, id, 'edit');
    const input = await parseBody(c, contentSchema);
    const access = requireAccess(db, userId, id, 'edit');
    return c.json(pages.updateContent(db, access.ownerId, id, input.content, version, now, input.overwrite ? 'overwrite' : 'autosave', userId));
  });

  app.patch('/:id', async c => {
    const { db, userId, now } = ctx(c);
    const id = c.req.param('id');
    requireAccess(db, userId, id, 'edit');
    const input = await parseBody(c, patchPageSchema);
    const access = requireAccess(db, userId, id, 'edit');
    if (access.role !== 'owner') {
      // A member with edit access renames a note and nothing else: icon, cover and layout stay the owner's, and a
      // row's name is one of its cells.
      if (Object.keys(input).some(key => key !== 'title') || pages.loadPage(db, access.ownerId, id).kind !== 'page') throw new AppError('forbidden', '只有擁有者可以變更這個頁面的設定。');
    }
    const row = pages.patchPage(db, access.ownerId, id, input, now);
    // The title is part of the path a member sees, so resolve again after the change.
    return c.json<PageResponse>(pageResponse(db, access.role === 'owner' ? access : requireAccess(db, userId, id, 'view'), row));
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
