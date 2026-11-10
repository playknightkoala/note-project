import { Hono } from 'hono';
import type { Breadcrumb, PageResponse } from '../../shared/api.ts';
import type { DatabaseStamp } from '../../shared/offline.ts';
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
import * as shares from '../services/shares.ts';
import { pageResponse, requireAccess, resolveAccess, rowResponse } from '../services/access.ts';

/** Long enough for a device that was offline for weeks to finish a retry; after that a repeat is judged on its own. */
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whose data an operation works on, once the caller's right to carry it out is established. Rows may be changed by
 * the members with edit access, discussions by anyone who may read the page, the structure of a database only by
 * its owner. This runs before the receipt is looked at: somebody who lost access learns nothing from a repeat.
 */
interface Target { ownerId: string; /** May change what everybody sees of a discussion: the owner and members with edit access. */ moderator: boolean }
function targetOf(db: Db, userId: string, op: OfflineOp): Target {
  const of = (access: { ownerId: string; role: string }): Target => ({ ownerId: access.ownerId, moderator: access.role !== 'viewer' });
  if (op.type === 'row.create') return of(requireAccess(db, userId, op.databaseId, 'edit'));
  if (op.type === 'row.update') {
    try { return of(requireAccess(db, userId, op.rowId, 'edit')); }
    catch (error) { if (error instanceof AppError && error.code === 'not_found') throw new AppError('not_found', '找不到資料列。'); throw error; }
  }
  if ('pageId' in op) return of(requireAccess(db, userId, op.pageId, 'comment'));
  if (requireAccess(db, userId, op.databaseId, 'view').role !== 'owner') throw new AppError('forbidden', '只有擁有者可以變更資料庫的欄位與視圖。');
  return { ownerId: userId, moderator: true };
}

function runOp(db: Db, { ownerId, moderator }: Target, actorId: string, op: OfflineOp, force: boolean, now: number): void {
  // A structure change is checked against the version it was made on, unless the user chose to apply it regardless.
  const version = isSchemaOp(op) && !force ? op.baseVersion : null;
  switch (op.type) {
    case 'row.create': databases.addRow(db, ownerId, op.databaseId, { title: op.title, values: op.values }, null, now, op.rowId); return;
    case 'row.update':
      if (databases.getRow(db, ownerId, op.rowId).databaseId !== op.databaseId) throw new AppError('not_found', '找不到資料列。');
      databases.changeRow(db, ownerId, op.rowId, { title: op.title, values: op.values }, force, now); return;
    case 'property.add': databases.addProperty(db, ownerId, op.databaseId, op.input, version, now, op.propertyId); return;
    case 'property.update': databases.updateProperty(db, ownerId, op.databaseId, op.propertyId, op.input, version, now); return;
    case 'property.delete': databases.deleteProperty(db, ownerId, op.databaseId, op.propertyId, version, now); return;
    case 'view.add': databases.addView(db, ownerId, op.databaseId, op.input, version, now, op.viewId); return;
    case 'view.update': databases.updateView(db, ownerId, op.databaseId, op.viewId, op.input, version, now); return;
    case 'view.delete': databases.deleteView(db, ownerId, op.databaseId, op.viewId, version, now); return;
    case 'annotation.create': annotations.createAnnotation(db, ownerId, op.pageId, { id: op.annotationId, messageId: op.messageId, quote: op.quote, blockIds: op.blockIds, text: op.text, emoji: op.emoji, at: op.at, floating: op.floating }, now, actorId); return;
    case 'annotation.comment': annotations.changeAnnotation(db, ownerId, op.pageId, op.annotationId, { action: 'comment', text: op.text, messageId: op.messageId, at: op.at }, null, now, actorId); return;
    case 'annotation.reaction': annotations.changeAnnotation(db, ownerId, op.pageId, op.annotationId, { action: 'reaction', emoji: op.emoji, on: op.on }, null, now, actorId); return;
    case 'annotation.resolve': annotations.changeAnnotation(db, ownerId, op.pageId, op.annotationId, { action: 'resolve', resolved: op.resolved }, null, now, actorId, moderator); return;
    case 'annotation.delete': {
      // Comments are only ever appended: more of them than the user saw means a reply this deletion would take along.
      const current = annotations.getAnnotation(db, ownerId, op.pageId, op.annotationId, actorId);
      if (current && !force && current.messages.length > op.messages) throw new AppError('version_conflict', '這則討論在其他地方有新的留言，請確認後再刪除。');
      annotations.deleteAnnotation(db, ownerId, op.pageId, op.annotationId, null, actorId); return;
    }
  }
}

/** What the operation's target looks like now. Also the answer to a repeated operation, which changes nothing. */
function resultOf(db: Db, ownerId: string, actorId: string, op: OfflineOp): OfflineOpResult {
  const optional = <T>(read: () => T): T | undefined => {
    try { return read(); } catch (error) { if (error instanceof AppError && error.code === 'not_found') return undefined; throw error; }
  };
  if (op.type === 'row.create' || op.type === 'row.update') {
    const row = optional(() => databases.getRow(db, ownerId, op.rowId));
    return row && row.databaseId === op.databaseId ? { row } : {};
  }
  if ('databaseId' in op) { const database = optional(() => databases.getDatabase(db, ownerId, op.databaseId)); return database ? { database } : {}; }
  if (!optional(() => pages.loadPage(db, ownerId, op.pageId))) return {};
  const annotation = annotations.getAnnotation(db, ownerId, op.pageId, op.annotationId, actorId);
  return annotation ? { annotation } : op.type === 'annotation.delete' ? { deletedId: op.annotationId } : {};
}

/** A page without its text, for the lists a device checks for changes: content is never loaded just for that. */
const LIGHT = `SELECT id, user_id, parent_id, kind, database_id, title, icon, cover_file_id, cover_preset, cover_position, full_width, version, is_favorite,
  trashed_at, created_at, updated_at, '[]' AS content FROM pages`;

export function offlineRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/manifest', c => {
    const { db, config } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const tree = pages.listTree(db, userId);
    const nodes = new Map(tree.map(node => [node.id, node]));
    const rows = db.all<pages.PageRow>(`${LIGHT} WHERE user_id = ? AND kind = 'page' AND trashed_at IS NULL`, userId);
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
    // What other accounts share with this one is kept on the device the same way. Each page is resolved exactly as
    // when it is opened, so its entry here equals what `GET /api/pages/:id` answers and nothing is downloaded twice.
    const stamps: DatabaseStamp[] = databases.databaseStamps(db, userId), discussed: string[] = [];
    for (const item of shares.incomingPages(db, userId)) {
      let access;
      try { access = resolveAccess(db, userId, item.id); } catch { continue; }
      if (item.kind === 'database') stamps.push(...databases.databaseStamps(db, item.ownerId, item.id));
      else discussed.push(item.id);
      if (item.kind !== 'page') continue;
      const row = db.get<pages.PageRow>(`${LIGHT} WHERE id = ? AND user_id = ? AND trashed_at IS NULL`, item.id, item.ownerId);
      if (row) summaries.push(summarizePage(pageResponse(db, access, row)));
    }
    return c.json<OfflineManifest>({ userId, tree, pages: summaries, maxUploadBytes: config.maxUploadBytes, databases: stamps,
      annotations: [...annotations.annotationStamps(db, userId), ...annotations.annotationStampsOf(db, discussed)], shared: shares.incomingShares(db, userId) });
  });
  app.get('/databases/:id', c => {
    const { db } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const access = requireAccess(db, userId, c.req.param('id'), 'view');
    const { pages: rows, ...rest } = databases.snapshot(db, access.ownerId, c.req.param('id'));
    // Every row page shares the database's own trail; only the last step differs.
    const page = pageResponse(db, access, pages.loadPage(db, access.ownerId, c.req.param('id')));
    return c.json<DatabaseSnapshotDto>({ ...rest, page, pages: rows.map(row => summarizePage(rowResponse(db, access, page.breadcrumbs, row))) });
  });
  /** Notes and row pages by id, content included. Unknown, trashed or unshared ids are left out, never reported. */
  app.get('/pages', c => {
    const { db } = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const { ids } = parseValue(c.req.query(), pageBatchSchema);
    const found: PageResponse[] = [];
    for (const id of new Set(ids)) {
      let access;
      try { access = resolveAccess(db, userId, id); } catch { continue; }
      const row = db.get<pages.PageRow>("SELECT * FROM pages WHERE id = ? AND user_id = ? AND trashed_at IS NULL AND kind IN ('page', 'row')", id, access.ownerId);
      if (row) found.push(pageResponse(db, access, row));
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
      const target = targetOf(db, userId, input.op);
      const done = db.get('SELECT 1 FROM offline_receipts WHERE user_id = ? AND operation_id = ?', userId, input.operationId);
      if (!done) {
        runOp(db, target, userId, input.op, input.force, now());
        db.run('DELETE FROM offline_receipts WHERE created_at < ?', now() - RECEIPT_TTL_MS);
        db.run('INSERT INTO offline_receipts (user_id, operation_id, created_at) VALUES (?, ?, ?)', userId, input.operationId, now());
      }
      return resultOf(db, target.ownerId, userId, input.op);
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
        // A repeat is answered with the page as the caller may see it now: after a downgrade or a removal the answer
        // stored at the time would say more than they are still entitled to.
        const access = requireAccess(db, userId, id, 'view');
        return pageResponse(db, access, pages.loadPage(db, access.ownerId, id));
      }
      let row, ownerId = userId;
      if (input.baseVersion === null) {
        // A new note is always the caller's own, under one of their own pages.
        row = pages.createPage(db, userId, { parentId: input.parentId, kind: 'page', title: input.title, afterId: null, icon: null }, now(), id);
      } else {
        ownerId = requireAccess(db, userId, id, 'edit').ownerId;
        row = pages.loadPage(db, ownerId, id);
        if (row.kind === 'database') throw new AppError('bad_request', '資料庫頁面沒有可同步的內文。');
        // A row's name is one of its cells and travels with the row changes; only its content is synced here.
        if (row.version !== input.baseVersion || (row.kind === 'page' && row.title !== input.baseTitle)) {
          throw new AppError('version_conflict', undefined, { current: pages.headOf(row) });
        }
      }
      pages.updateContent(db, ownerId, id, input.content, row.version, now(), input.overwrite ? 'overwrite' : 'autosave', userId);
      row = row.kind === 'page' ? pages.patchPage(db, ownerId, id, { title: input.title }, now()) : pages.loadPage(db, ownerId, id);
      const result = pageResponse(db, requireAccess(db, userId, id, 'view'), row);
      // Only the last acknowledged operation per page is needed: clients serialize operations and retry before advancing.
      db.run('DELETE FROM offline_operations WHERE user_id = ? AND page_id = ?', userId, id);
      db.run('INSERT INTO offline_operations (user_id, operation_id, page_id, response) VALUES (?, ?, ?, ?)', userId, input.operationId, id, JSON.stringify(result));
      return result;
    });
    return c.json(response);
  });
  return app;
}
