import { Hono } from 'hono';
import type { Breadcrumb, PageResponse } from '../../shared/api.ts';
import { pageIdSchema } from '../../shared/api.ts';
import { summarizePage, syncNoteSchema } from '../../shared/offline.ts';
import type { OfflineManifest } from '../../shared/offline.ts';
import { AppError } from '../../shared/errors.ts';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody } from './validate.ts';
import { expectedVersion } from './pages.ts';
import * as pages from '../services/pages.ts';

export function offlineRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/manifest', c => {
    const { db, config } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const tree = pages.listTree(db, userId);
    const nodes = new Map(tree.map(node => [node.id, node]));
    // Do not load or transfer BlockNote content just to check for changes.
    const rows = db.all<pages.PageRow>(`SELECT id, parent_id, kind, database_id, title, icon,
      cover_file_id, cover_preset, cover_position, full_width, version, is_favorite,
      trashed_at, created_at, updated_at, '[]' AS content
      FROM pages WHERE user_id = ? AND kind = 'page' AND trashed_at IS NULL`, userId);
    const summaries = rows.map(row => {
      const breadcrumbs: Breadcrumb[] = [], seen = new Set<string>();
      let node = nodes.get(row.id);
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        breadcrumbs.unshift({ id: node.id, title: node.title, icon: node.icon, kind: node.kind });
        node = node.parentId ? nodes.get(node.parentId) : undefined;
      }
      return summarizePage({ page: pages.toPageDto(row), breadcrumbs });
    });
    return c.json<OfflineManifest>({ userId, tree, pages: summaries, maxUploadBytes: config.maxUploadBytes });
  });
  app.put('/pages/:id', async c => {
    const { db, now } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const id = c.req.param('id');
    if (!pageIdSchema.safeParse(id).success) throw new AppError('bad_request');
    const input = await parseBody(c, syncNoteSchema);
    if (expectedVersion(c) !== (input.baseVersion ?? 0)) throw new AppError('bad_request');
    const response = db.transaction(() => {
      const receipt = db.get<{ page_id: string; response: string }>('SELECT page_id, response FROM offline_operations WHERE user_id = ? AND operation_id = ?', userId, input.operationId);
      if (receipt) {
        if (receipt.page_id !== id) throw new AppError('bad_request');
        pages.loadPage(db, userId, id);
        return JSON.parse(receipt.response) as PageResponse;
      }
      let row;
      if (input.baseVersion === null) {
        row = pages.createPage(db, userId, { parentId: input.parentId, kind: 'page', title: input.title, afterId: null, icon: null }, now(), id);
      } else {
        row = pages.loadPage(db, userId, id);
        if (row.kind !== 'page') throw new AppError('bad_request', '離線同步目前只支援一般筆記。');
        if (row.version !== input.baseVersion || row.title !== input.baseTitle) {
          throw new AppError('version_conflict', undefined, { current: pages.headOf(row) });
        }
      }
      pages.updateContent(db, userId, id, input.content, row.version, now(), input.overwrite ? 'overwrite' : 'autosave');
      row = pages.patchPage(db, userId, id, { title: input.title }, now());
      const result: PageResponse = { page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) };
      // Only the last acknowledged operation per page is needed: clients serialize operations and retry before advancing.
      db.run('DELETE FROM offline_operations WHERE user_id = ? AND page_id = ?', userId, id);
      db.run('INSERT INTO offline_operations (user_id, operation_id, page_id, response) VALUES (?, ?, ?, ?)', userId, input.operationId, id, JSON.stringify(result));
      return result;
    });
    return c.json(response);
  });
  return app;
}
