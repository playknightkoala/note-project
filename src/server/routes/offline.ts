import { Hono } from 'hono';
import type { Breadcrumb, PageResponse } from '../../shared/api.ts';
import { pageIdSchema } from '../../shared/api.ts';
import { isSchemaOp, offlineOpRequestSchema, pageBatchSchema, summarizePage, syncNoteSchema } from '../../shared/offline.ts';
import type { DatabaseSnapshotDto, OfflineManifest, OfflineOp, OfflineOpResult } from '../../shared/offline.ts';
import type { Db } from '../db/driver.ts';
import { AppError } from '../../shared/errors.ts';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody, parseValue } from './validate.ts';
import { expectedVersion } from './pages.ts';
import * as pages from '../services/pages.ts';
import * as databases from '../services/databases.ts';
import * as annotations from '../services/annotations.ts';

/** Long enough for a device that was offline for weeks to finish a retry; after that a repeat is judged on its own. */
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function runOp(db: Db, userId: string, op: OfflineOp, force: boolean, now: number): void {
  // A structure change is checked against the version it was made on, unless the user chose to apply it regardless.
  const version = isSchemaOp(op) && !force ? op.baseVersion : null;
  switch (op.type) {
    case 'row.create': databases.addRow(db, userId, op.databaseId, { title: op.title, values: op.values }, null, now, op.rowId); return;
    case 'row.update':
      if (databases.getRow(db, userId, op.rowId).databaseId !== op.databaseId) throw new AppError('not_found', '找不到資料列。');
      databases.changeRow(db, userId, op.rowId, { title: op.title, values: op.values }, force, now); return;
    case 'property.add': databases.addProperty(db, userId, op.databaseId, op.input, version, now, op.propertyId); return;
    case 'property.update': databases.updateProperty(db, userId, op.databaseId, op.propertyId, op.input, version, now); return;
    case 'property.delete': databases.deleteProperty(db, userId, op.databaseId, op.propertyId, version, now); return;
    case 'view.add': databases.addView(db, userId, op.databaseId, op.input, version, now, op.viewId); return;
    case 'view.update': databases.updateView(db, userId, op.databaseId, op.viewId, op.input, version, now); return;
    case 'view.delete': databases.deleteView(db, userId, op.databaseId, op.viewId, version, now); return;
    case 'annotation.create': annotations.createAnnotation(db, userId, op.pageId, { id: op.annotationId, messageId: op.messageId, quote: op.quote, blockIds: op.blockIds, text: op.text, emoji: op.emoji, at: op.at }, now); return;
    case 'annotation.comment': annotations.changeAnnotation(db, userId, op.pageId, op.annotationId, { action: 'comment', text: op.text, messageId: op.messageId, at: op.at }, null, now); return;
    case 'annotation.reaction': annotations.changeAnnotation(db, userId, op.pageId, op.annotationId, { action: 'reaction', emoji: op.emoji, on: op.on }, null, now); return;
    case 'annotation.resolve': annotations.changeAnnotation(db, userId, op.pageId, op.annotationId, { action: 'resolve', resolved: op.resolved }, null, now); return;
    case 'annotation.delete': {
      // Comments are only ever appended: more of them than the user saw means a reply this deletion would take along.
      const current = annotations.getAnnotation(db, userId, op.pageId, op.annotationId);
      if (current && !force && current.messages.length > op.messages) throw new AppError('version_conflict', '這則討論在其他地方有新的留言，請確認後再刪除。');
      annotations.deleteAnnotation(db, userId, op.pageId, op.annotationId, null); return;
    }
  }
}

/** What the operation's target looks like now. Also the answer to a repeated operation, which changes nothing. */
function resultOf(db: Db, userId: string, op: OfflineOp): OfflineOpResult {
  const optional = <T>(read: () => T): T | undefined => {
    try { return read(); } catch (error) { if (error instanceof AppError && error.code === 'not_found') return undefined; throw error; }
  };
  if (op.type === 'row.create' || op.type === 'row.update') {
    const row = optional(() => databases.getRow(db, userId, op.rowId));
    return row && row.databaseId === op.databaseId ? { row } : {};
  }
  if ('databaseId' in op) { const database = optional(() => databases.getDatabase(db, userId, op.databaseId)); return database ? { database } : {}; }
  if (!optional(() => pages.loadPage(db, userId, op.pageId))) return {};
  const annotation = annotations.getAnnotation(db, userId, op.pageId, op.annotationId);
  return annotation ? { annotation } : op.type === 'annotation.delete' ? { deletedId: op.annotationId } : {};
}

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
    return c.json<OfflineManifest>({ userId, tree, pages: summaries, maxUploadBytes: config.maxUploadBytes,
      databases: databases.databaseStamps(db, userId), annotations: annotations.annotationStamps(db, userId) });
  });
  app.get('/databases/:id', c => {
    const { db } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const { pages: rows, ...rest } = databases.snapshot(db, userId, c.req.param('id'));
    // Every row page shares the database's own trail; only the last step differs.
    const page = pages.loadPage(db, userId, c.req.param('id'));
    const trail = pages.breadcrumbs(db, userId, page);
    return c.json<DatabaseSnapshotDto>({ ...rest, page: { page: pages.toPageDto(page), breadcrumbs: trail }, pages: rows.map(row => summarizePage({ page: pages.toPageDto(row), breadcrumbs: [...trail, { id: row.id, title: row.title, icon: row.icon, kind: row.kind }] })) });
  });
  /** Notes and row pages by id, content included. Unknown, trashed or foreign ids are left out, never reported. */
  app.get('/pages', c => {
    const { db } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const { ids } = parseValue(c.req.query(), pageBatchSchema);
    const found: PageResponse[] = [];
    for (const id of new Set(ids)) {
      const row = db.get<pages.PageRow>("SELECT * FROM pages WHERE id = ? AND user_id = ? AND trashed_at IS NULL AND kind IN ('page', 'row')", id, userId);
      if (row) found.push({ page: pages.toPageDto(row), breadcrumbs: pages.breadcrumbs(db, userId, row) });
    }
    return c.json({ pages: found });
  });
  /**
   * One queued change to a database or a discussion. Carried out at most once per operation id: a device that never
   * saw the answer sends the same operation again and gets the current state back.
   */
  app.post('/ops', async c => {
    const { db, now } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const input = await parseBody(c, offlineOpRequestSchema);
    return c.json<OfflineOpResult>(db.transaction(() => {
      const done = db.get('SELECT 1 FROM offline_receipts WHERE user_id = ? AND operation_id = ?', userId, input.operationId);
      if (!done) {
        runOp(db, userId, input.op, input.force, now());
        db.run('DELETE FROM offline_receipts WHERE created_at < ?', now() - RECEIPT_TTL_MS);
        db.run('INSERT INTO offline_receipts (user_id, operation_id, created_at) VALUES (?, ?, ?)', userId, input.operationId, now());
      }
      return resultOf(db, userId, input.op);
    }));
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
        if (row.kind === 'database') throw new AppError('bad_request', '資料庫頁面沒有可同步的內文。');
        // A row's name is one of its cells and travels with the row changes; only its content is synced here.
        if (row.version !== input.baseVersion || (row.kind === 'page' && row.title !== input.baseTitle)) {
          throw new AppError('version_conflict', undefined, { current: pages.headOf(row) });
        }
      }
      pages.updateContent(db, userId, id, input.content, row.version, now(), input.overwrite ? 'overwrite' : 'autosave');
      row = row.kind === 'page' ? pages.patchPage(db, userId, id, { title: input.title }, now()) : pages.loadPage(db, userId, id);
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
