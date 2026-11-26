// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageResponse, UserDto } from '../../src/shared/api.ts';
import type { Annotation } from '../../src/shared/annotations.ts';
import type { DatabaseDto, DatabaseRow } from '../../src/shared/database.ts';
import { summarizePage } from '../../src/shared/offline.ts';
import type { DatabaseSnapshotDto, OfflineManifest, OfflineOp } from '../../src/shared/offline.ts';
import { cachePage, createLocalNote, createLocalRow, forgetOfflineData, loadNote, loadTree, offlineNote, rememberUser, renameLocalRow, resolveLocalNote, saveLocalContent, syncNotes, syncStatus, unsyncedWork } from '../../src/client/offline/notes.ts';
import { discardOp, localAnnotations, localDatabase, queuedOps, rememberAnnotations, retryOp, sendOps, storeDatabase, storedDatabase, submitOp } from '../../src/client/offline/outbox.ts';
import { pendingUploads, queueUpload, retryUpload, sendUploads } from '../../src/client/offline/uploads.ts';
import { uploadFile } from '../../src/client/api/files.ts';
import { OFFLINE_EVENT, clearLocal, readLocal, updateLocal } from '../../src/client/offline/storage.ts';

const uuid = () => crypto.randomUUID();
const account = (name: string): UserDto => ({ id: uuid(), displayName: name, email: `${name}@example.test`, username: null, role: 'user', createdAt: 0 });
const me = account('owner');
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });
const databaseId = uuid(), textId = uuid(), viewId = uuid(), rowId = uuid();
const meta = (version = 3): DatabaseDto => ({ id: databaseId, version, properties: [{ id: textId, name: '摘要', type: 'text', position: 1024, choices: [] }], views: [{ id: viewId, name: '表格', type: 'table', config: { sorts: [], filters: [] } }] });
const row = (changes: Partial<DatabaseRow> = {}): DatabaseRow => ({ id: rowId, databaseId, title: '列', icon: null, version: 1, values: { [textId]: '原文' }, updatedAt: 1, ...changes });
const pageOf = (kind: 'page' | 'row' | 'database', id = uuid(), version = 1): PageResponse => ({
  page: { id, parentId: kind === 'row' ? databaseId : null, kind, databaseId: kind === 'row' ? databaseId : null, title: kind === 'row' ? '列' : '標題', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 },
  breadcrumbs: [],
});
const edit = (value: string, base = '原文'): OfflineOp => ({ type: 'row.update', databaseId, rowId, values: { [textId]: { base, value } } });

interface Call { method: string; path: string; body: unknown }
type Answer = { status?: number; json?: unknown } | Response | 'offline' | undefined;
/** Minimal API double: answers by method and path, records every request; 'offline' is a dropped connection. */
function stubApi(answer: (call: Call) => Answer) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    const call = { method, path, body };
    calls.push(call);
    const reply = answer(call) ?? { status: 404, json: { error: { code: 'not_found', message: '找不到資料。' } } };
    if (reply === 'offline') throw new TypeError('network unavailable');
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }));
  return calls;
}
const ops = (calls: Call[]) => calls.filter(call => call.path === '/api/offline/ops').map(call => call.body as { operationId: string; force: boolean; op: OfflineOp });
const conflict = (message = '「摘要」已在其他地方更新。'): Answer => ({ status: 409, json: { error: { code: 'version_conflict', message } } });

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  online(false);
  await syncNotes(); await clearLocal();
  await rememberUser(me);
  await storeDatabase(me.id, { stamp: 's1', meta: meta(), rows: [row()] });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('one change to a database', () => {
  it('goes straight to the server when online, and its answer becomes the copy kept on this device', async () => {
    online(true);
    const calls = stubApi(call => call.path === '/api/offline/ops' ? { json: { row: row({ values: { [textId]: '伺服器存的值' }, version: 2 }) } } : undefined);
    const result = await submitOp(edit('新值'));
    expect(result).toMatchObject({ queued: false, row: { values: { [textId]: '伺服器存的值' } } });
    expect(ops(calls)).toMatchObject([{ force: false, op: edit('新值') }]);
    expect(await queuedOps()).toEqual([]);
    // Going offline right afterwards must not show the old value again.
    expect((await localDatabase(databaseId))?.rows[0]).toMatchObject({ values: { [textId]: '伺服器存的值' }, version: 2 });
  });

  it('reports a refusal to the caller without keeping the change', async () => {
    online(true);
    stubApi(() => conflict());
    await expect(submitOp(edit('新值'))).rejects.toMatchObject({ status: 409, message: '「摘要」已在其他地方更新。' });
    expect(await queuedOps()).toEqual([]);
    expect((await localDatabase(databaseId))?.rows[0]?.values).toEqual({ [textId]: '原文' });
  });

  it('is kept on this device when offline and shown on top of the downloaded copy', async () => {
    const calls = stubApi(() => 'offline');
    const added = uuid();
    const created = await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    const changed = await submitOp(edit('離線改的'));
    expect(calls).toEqual([]);
    expect(created).toMatchObject({ queued: true, row: { id: added, title: '離線新增' } });
    expect(changed).toMatchObject({ queued: true, row: { id: rowId, values: { [textId]: '離線改的' } } });
    expect((await localDatabase(databaseId))?.rows.map(item => item.title)).toEqual(['列', '離線新增']);
    // The downloaded copy is untouched until the server confirms.
    expect((await storedDatabase(me.id, databaseId))?.rows).toEqual([row()]);
    expect(await unsyncedWork()).toMatchObject({ changes: 2, total: 2 });
  });

  it('is queued under the same operation id when the connection drops mid-request, so it cannot apply twice', async () => {
    online(true);
    const calls = stubApi(() => 'offline');
    expect(await submitOp(edit('送出時斷線'))).toMatchObject({ queued: true });
    const [queued] = await queuedOps();
    expect(queued).toMatchObject({ id: ops(calls)[0]!.operationId, op: edit('送出時斷線') });
    // While something is waiting for this database, later changes queue behind it instead of overtaking it.
    const next = stubApi(call => call.path === '/api/offline/ops' ? { json: { row: row() } } : undefined);
    expect(await submitOp(edit('第二次', '送出時斷線'))).toMatchObject({ queued: true });
    expect(next).toEqual([]);
    await sendOps(me.id);
    expect(ops(next).map(item => item.op)).toEqual([edit('送出時斷線'), edit('第二次', '送出時斷線')]);
    expect(ops(next)[0]!.operationId).toBe(queued!.id);
    expect(await queuedOps()).toEqual([]);
  });
});

describe('the queue', () => {
  it('holds back a database after a refusal, keeps going elsewhere, and lets the user overwrite or discard', async () => {
    const pageId = uuid(), annotationId = uuid();
    await submitOp(edit('衝突的修改'));
    await submitOp(edit('之後的修改', '衝突的修改'));
    await submitOp({ type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: true });
    online(true);
    const calls = stubApi(call => {
      if (call.path !== '/api/offline/ops') return undefined;
      const { op, force } = call.body as { op: OfflineOp; force: boolean };
      if (op.type === 'row.update') return op.values[textId]!.value === '衝突的修改' && !force ? conflict() : { json: { row: row({ values: { [textId]: op.values[textId]!.value as string } }) } };
      return { json: { annotation: { id: annotationId, quote: '字', blockIds: ['b'], messages: [], reactions: ['👍'], resolved: false, version: 2, createdAt: 1, updatedAt: 2 } satisfies Annotation } };
    });
    await sendOps(me.id);
    // The first row change was refused; the second waited behind it; the discussion on another page went through.
    expect(ops(calls).map(item => item.op.type)).toEqual(['row.update', 'annotation.reaction']);
    let queue = await queuedOps();
    expect(queue).toMatchObject([{ op: edit('衝突的修改'), problem: '「摘要」已在其他地方更新。', conflict: true }, { op: edit('之後的修改', '衝突的修改') }]);
    expect(queue[1]!.problem).toBeUndefined();
    expect(await localAnnotations(pageId)).toMatchObject([{ id: annotationId, reactions: ['👍'] }]);
    // The user's edits stay visible while they wait.
    expect((await localDatabase(databaseId))?.rows[0]?.values).toEqual({ [textId]: '之後的修改' });
    await sendOps(me.id);
    expect(ops(calls)).toHaveLength(2);
    // "Apply mine anyway" sends the same operation again, marked as the user's explicit choice.
    await retryOp(queue[0]!.key, true);
    await sendOps(me.id);
    expect(ops(calls)[2]).toMatchObject({ operationId: queue[0]!.id, force: true, op: edit('衝突的修改') });
    expect(ops(calls)[3]).toMatchObject({ force: false, op: edit('之後的修改', '衝突的修改') });
    expect(await queuedOps()).toEqual([]);
    // Discarding instead removes just that change.
    online(false);
    await submitOp(edit('要捨棄的', '之後的修改'));
    queue = await queuedOps();
    await discardOp(queue[0]!.key);
    expect(await queuedOps()).toEqual([]);
    expect((await localDatabase(databaseId))?.rows[0]?.values).toEqual({ [textId]: '之後的修改' });
  });

  it('continues structure changes from the version the previous one produced, but not past a change made elsewhere', async () => {
    const first = uuid(), second = uuid(), third = uuid();
    const add = (propertyId: string, name: string): OfflineOp => ({ type: 'property.add', databaseId, baseVersion: 3, propertyId, input: { name, type: 'text', choices: [] } });
    await submitOp(add(first, '甲')); await submitOp(add(second, '乙'));
    expect((await localDatabase(databaseId))?.meta.properties.map(item => item.name)).toEqual(['摘要', '甲', '乙']);
    online(true);
    let version = 3;
    const calls = stubApi(call => {
      if (call.path !== '/api/offline/ops') return undefined;
      const { op, force } = call.body as { op: Extract<OfflineOp, { type: 'property.add' }>; force: boolean };
      if (!force && op.baseVersion !== version) return conflict('資料已在其他地方更新，請重新載入後再修改。');
      return { json: { database: meta(++version) } };
    });
    await sendOps(me.id);
    expect(ops(calls).map(item => (item.op as { baseVersion: number }).baseVersion)).toEqual([3, 4]);
    expect(await queuedOps()).toEqual([]);
    expect((await storedDatabase(me.id, databaseId))?.meta.version).toBe(5);
    // Another device changed the structure (5 → 7) while two more changes were made here on version 5.
    online(false);
    await submitOp({ ...add(third, '丙'), baseVersion: 5 } as OfflineOp); await submitOp({ ...add(uuid(), '丁'), baseVersion: 5 } as OfflineOp);
    version = 7; online(true);
    await sendOps(me.id);
    const [refused, behind] = await queuedOps();
    expect(refused).toMatchObject({ conflict: true, problem: '資料已在其他地方更新，請重新載入後再修改。' });
    await retryOp(refused!.key, true);
    await sendOps(me.id);
    // Forcing one change does not silently carry the next one over the foreign change as well.
    expect(await queuedOps()).toMatchObject([{ key: behind!.key, conflict: true, op: { baseVersion: 5 } }]);
  });

  it('discards a row made here together with the changes and the page that depend on it', async () => {
    const added = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    await submitOp({ type: 'row.update', databaseId, rowId: added, values: { [textId]: { base: null, value: 'x' } } });
    await submitOp(edit('別列的修改'));
    await submitOp({ type: 'annotation.reaction', pageId: added, annotationId: uuid(), emoji: '👍', on: true });
    expect((await loadNote(added)).page).toMatchObject({ kind: 'row', databaseId, title: '離線新增', version: 1 });
    await discardOp((await queuedOps())[0]!.key);
    expect((await queuedOps()).map(item => item.op)).toEqual([edit('別列的修改')]);
    expect(await offlineNote(added)).toBeUndefined();
  });

  it('stops, without blaming the change, when the session is gone or no longer the one the sync started with', async () => {
    await submitOp(edit('換帳號時的修改'));
    online(true);
    for (const refusal of [{ status: 401, json: { error: { code: 'unauthorized', message: '請先登入。' } } }, { status: 403, json: { error: { code: 'csrf', message: '請求來源驗證失敗。' } } }]) {
      stubApi(() => refusal);
      await expect(sendOps(me.id)).rejects.toMatchObject({ status: refusal.status });
      expect(await queuedOps()).toMatchObject([{ op: edit('換帳號時的修改') }]);
      expect((await queuedOps())[0]!.problem).toBeUndefined();
    }
    // A plain "forbidden" is about the change itself and is recorded on it.
    stubApi(() => ({ status: 403, json: { error: { code: 'forbidden', message: '沒有權限執行此操作。' } } }));
    await sendOps(me.id);
    expect(await queuedOps()).toMatchObject([{ problem: '沒有權限執行此操作。', conflict: false }]);
  });

  it('applies a reply written right after the connection dropped to the discussion the server had just shown', async () => {
    const pageId = uuid(), messageId = uuid();
    const shown: Annotation = { id: uuid(), quote: '字', blockIds: ['b'], messages: [{ id: uuid(), text: '線上的留言', createdAt: 1 }], reactions: [], resolved: false, version: 1, createdAt: 1, updatedAt: 1 };
    // Not downloaded by a sync yet; the list just read from the server is kept as the copy to build on.
    await rememberAnnotations(pageId, [shown]);
    const reply = await submitOp({ type: 'annotation.comment', pageId, annotationId: shown.id, messageId, text: '斷線後的回覆', at: 2 });
    expect(reply).toMatchObject({ queued: true, annotation: { id: shown.id, messages: [{ text: '線上的留言' }, { id: messageId, text: '斷線後的回覆' }] } });
    expect((await localAnnotations(pageId))[0]?.messages).toHaveLength(2);
  });

  it('keeps discussions on a page made offline until that page exists on the server', async () => {
    const note = await createLocalNote({ title: '離線新頁' });
    const pageId = note.page.id, annotationId = uuid();
    online(true);
    const session = { user: me, csrfToken: 'synthetic-token' };
    const order: string[] = [];
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: session };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/offline/ops') { order.push('discussion'); return { json: { annotation: { id: annotationId, quote: '字', blockIds: ['b'], messages: [], reactions: ['🎉'], resolved: false, version: 1, createdAt: 1, updatedAt: 1 } } }; }
      if (call.method === 'PUT') { order.push('page'); return { json: { ...note, page: { ...note.page, version: 1 } } }; }
      return undefined;
    });
    // Even online, a discussion cannot be sent before its page: it is queued and follows the page in the same sync.
    const result = await submitOp({ type: 'annotation.create', pageId, annotationId, messageId: uuid(), quote: '字', blockIds: ['b'], emoji: '🎉', at: 1 });
    expect(result).toMatchObject({ queued: true, annotation: { id: annotationId, reactions: ['🎉'] } });
    expect(ops(calls)).toEqual([]);
    await syncNotes({ force: true });
    expect(order).toEqual(['page', 'discussion']);
    expect(await unsyncedWork()).toMatchObject({ total: 0 });
    expect(syncStatus.phase).toBe('complete');
  });
});

describe('downloading for offline use', () => {
  const rowPage = pageOf('row', rowId), databasePage = pageOf('database', databaseId);
  const snapshot = (stamp: string, rows = [row()], pages = [rowPage]): DatabaseSnapshotDto => ({ stamp, meta: meta(), rows, page: databasePage, pages: pages.map(summarizePage) });
  function server(state: { manifest: OfflineManifest; snapshot: DatabaseSnapshotDto; annotations: Annotation[] }) {
    return stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: state.manifest };
      if (call.path === `/api/offline/databases/${databaseId}`) return { json: state.snapshot };
      if (call.path.startsWith('/api/offline/pages?ids=')) return { json: { pages: call.path.split('=')[1]!.split(',').filter(id => id === rowId).map(() => rowPage) } };
      if (call.path.endsWith('/annotations')) return { json: { annotations: state.annotations } };
      if (call.path === '/api/pages/tree') return { json: { pages: [] } };
      return undefined;
    });
  }
  const manifest = (stamp: string, annotations: OfflineManifest['annotations'] = []): OfflineManifest => ({ userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp }], annotations });

  it('fetches a database, its row pages and discussions only when their stamps changed, and drops what was deleted online', async () => {
    const discussion: Annotation = { id: uuid(), quote: '字', blockIds: ['b'], messages: [{ id: uuid(), text: '留言', createdAt: 1 }], reactions: [], resolved: false, version: 1, createdAt: 1, updatedAt: 1 };
    const state = { manifest: manifest('s2', [{ pageId: rowId, stamp: 'a1' }]), snapshot: snapshot('s2', [row({ title: '另一台改名' })]), annotations: [discussion] };
    online(true);
    const calls = server(state);
    await syncNotes({ force: true });
    expect(await storedDatabase(me.id, databaseId)).toMatchObject({ stamp: 's2', rows: [{ title: '另一台改名' }] });
    expect((await offlineNote(rowId))?.local.page.kind).toBe('row');
    expect((await offlineNote(databaseId))?.local.page.kind).toBe('database');
    expect(await localAnnotations(rowId)).toEqual([discussion]);
    expect(syncStatus.phase).toBe('complete');
    const downloads = calls.filter(call => call.path.startsWith('/api/offline/databases/') || call.path.startsWith('/api/offline/pages') || call.path.endsWith('/annotations')).length;
    expect(downloads).toBe(3);
    // Nothing changed: only the manifest is asked for.
    await syncNotes({ force: true });
    expect(calls.filter(call => call.path.startsWith('/api/offline/databases/') || call.path.startsWith('/api/offline/pages') || call.path.endsWith('/annotations'))).toHaveLength(downloads);
    // Offline the database, its row page and the discussion are all readable from this device.
    online(false);
    stubApi(() => 'offline');
    expect((await loadNote(rowId)).page.title).toBe('列');
    expect((await localDatabase(databaseId))?.rows[0]?.title).toBe('另一台改名');
    // The row and the discussions were deleted online; then the whole database.
    online(true);
    server(state);
    state.manifest = manifest('s3'); state.snapshot = snapshot('s3', [], []);
    await syncNotes({ force: true });
    expect((await offlineNote(rowId))?.removed).toBe(true);
    expect(await localAnnotations(rowId)).toEqual([]);
    state.manifest = { ...manifest('s3'), databases: [] };
    await syncNotes({ force: true });
    expect(await storedDatabase(me.id, databaseId)).toBeUndefined();
    expect((await offlineNote(databaseId))?.removed).toBe(true);
  });

  it('never replaces a row page that has unsynced text, and keeps a row made here that the server does not list yet', async () => {
    const cached = await cachePage(rowPage);
    await saveLocalContent(rowId, [{ id: 'draft' }], cached.localRevision);
    const added = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    online(true);
    const state = { manifest: manifest('s2'), snapshot: snapshot('s2', [row()], [{ ...rowPage, page: { ...rowPage.page, version: 2 } }]), annotations: [] };
    const calls = server(state);
    // The queue is refused, so the row made here stays local-only through the download.
    const fetcher = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path) === '/api/offline/ops' || init?.method === 'PUT'
      ? new Response(JSON.stringify({ error: { code: 'conflict', message: '每個資料庫最多 5,000 列（包含垃圾桶），請先永久刪除不需要的列。' } }), { status: 409 }) : fetcher(path, init));
    await syncNotes({ force: true });
    expect(calls.some(call => call.path.startsWith('/api/offline/pages'))).toBe(false);
    expect(await offlineNote(rowId)).toMatchObject({ pending: true, local: { page: { content: [{ id: 'draft' }] } } });
    expect(await offlineNote(added)).toMatchObject({ localOnly: true });
    expect((await offlineNote(added))?.removed).toBeUndefined();
    // Once the server lists that row (its creation was confirmed from another tab), its page is free to sync.
    state.manifest = manifest('s3'); state.snapshot = snapshot('s3', [row(), row({ id: added, title: '離線新增' })], [rowPage, pageOf('row', added)]);
    await syncNotes({ force: true });
    expect((await offlineNote(added))?.localOnly).toBeUndefined();
    expect((await localDatabase(databaseId))?.rows.map(item => item.title)).toEqual(['列', '離線新增']);
    // A row with unsynced text belongs to its database, not to the page tree.
    expect((await loadTree()).map(node => node.id)).toEqual([]);
    // A plain refusal (not a version conflict) offers retry or discard, not "apply mine anyway".
    expect(await queuedOps()).toMatchObject([{ problem: expect.stringContaining('5,000'), conflict: false }]);
    expect(syncStatus.phase).toBe('pending');
  });

  it('learns that a shared database became read-only, also for a row whose text still waits here', async () => {
    const owner = { id: uuid(), name: '擁有者' };
    const as = (page: PageResponse, role: 'viewer' | 'editor'): PageResponse => ({ ...page, access: { role, rootId: databaseId, owner } });
    const other = uuid(), otherPage = pageOf('row', other);
    const draft = await cachePage(as(rowPage, 'editor'));
    await cachePage(as(otherPage, 'editor')); await cachePage(as(databasePage, 'editor'));
    await storeDatabase(me.id, { stamp: 's1.editor', meta: meta(), rows: [row(), row({ id: other })] });
    await saveLocalContent(rowId, [{ id: 'draft' }], draft.localRevision);
    online(true);
    // Nothing in the database changed: only the role did, and with it the stamp.
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.method === 'PUT') return { status: 403, json: { error: { code: 'forbidden', message: '這個頁面以唯讀方式與你共用，無法修改。' } } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1.viewer' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === `/api/offline/databases/${databaseId}`) return { json: { stamp: 's1.viewer', meta: meta(), rows: [row(), row({ id: other })], page: as(databasePage, 'viewer'), pages: [as(rowPage, 'viewer'), as(otherPage, 'viewer')].map(summarizePage) } satisfies DatabaseSnapshotDto };
      if (call.path.startsWith('/api/offline/pages?ids=')) return { json: { pages: [as(otherPage, 'viewer')] } };
      return undefined;
    });
    await syncNotes({ force: true });
    expect(calls.find(call => call.path.startsWith('/api/offline/pages?ids='))?.path).toBe(`/api/offline/pages?ids=${other}`);
    expect((await offlineNote(other))?.local.access?.role).toBe('viewer');
    expect((await offlineNote(databaseId))?.local.access?.role).toBe('viewer');
    // The draft is still here, with its baseline, and now knows it may not be written.
    expect(await offlineNote(rowId)).toMatchObject({ pending: true, local: { access: { role: 'viewer' }, page: { content: [{ id: 'draft' }] } }, base: { access: { role: 'viewer' }, page: { version: 1 } } });
    expect((await storedDatabase(me.id, databaseId))?.stamp).toBe('s1.viewer');
  });
});

describe('a row page kept on this device', () => {
  it('follows the row being renamed, here or elsewhere, without treating it as an edit of its text', async () => {
    const rowPage = pageOf('row', rowId);
    const cached = await cachePage(rowPage);
    expect((await renameLocalRow(rowId, '此裝置改名'))?.page.title).toBe('此裝置改名');
    expect(await offlineNote(rowId)).toMatchObject({ revision: cached.localRevision, pending: false, local: { page: { title: '此裝置改名' } } });
    // The same text arrives with a name changed on another device: an open editor must not see a new revision.
    const renamed = await cachePage({ ...rowPage, page: { ...rowPage.page, title: '另一台改名', updatedAt: 5 } });
    expect(renamed).toMatchObject({ localRevision: cached.localRevision, page: { title: '另一台改名' } });
    expect((await cachePage({ ...rowPage, page: { ...rowPage.page, version: 2, content: [{ id: 'new' }] } })).localRevision).not.toBe(cached.localRevision);
    // Renaming something that is not a row is not this function's business.
    const note = await cachePage(pageOf('page'));
    expect((await renameLocalRow(note.page.id, 'x'))?.page.title).toBe('標題');
  });
});

describe('attachments added offline', () => {
  const stores = new Map<string, Map<string, Response>>();
  // jsdom's File cannot be read as a stream, which the platform Response needs; a browser's File can.
  const fileOf = (parts: (string | Uint8Array)[], name: string, type = '') => new NodeFile(parts, name, { type }) as unknown as File;
  const png = () => fileOf([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], '離線照片.png', 'image/png');
  beforeEach(() => {
    stores.clear();
    vi.stubGlobal('caches', {
      keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        const store = stores.get(name) ?? stores.set(name, new Map()).get(name)!;
        return { put: async (url: string, response: Response) => { store.set(url, response); }, match: async (url: string) => store.get(url)?.clone(), delete: async (url: string) => store.delete(url) };
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {} } });
  });
  afterEach(() => { Reflect.deleteProperty(navigator, 'serviceWorker'); });

  /** What the offline interface does for an attachment address while the server cannot be reached. */
  const worker = (call: Call): Answer => call.path.startsWith('/api/files/') ? stores.get(`notes-uploads-${me.id}`)?.get(call.path)?.clone() ?? { status: 503 } : 'offline';

  it('keeps the file on this device under its final address, then uploads it once and keeps it readable', async () => {
    const calls = stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    expect(calls.map(call => call.path)).toEqual([file.url]);
    expect(file).toMatchObject({ queued: true, mime: 'image/png', name: '離線照片.png', url: `/api/files/${file.id}/${encodeURIComponent('離線照片.png')}` });
    const waiting = stores.get(`notes-uploads-${me.id}`)!.get(file.url)!;
    // Served to this account only, as an image; nothing else would be shown inline.
    expect(Object.fromEntries(waiting.headers)).toMatchObject({ 'content-type': 'image/png', 'content-disposition': expect.stringMatching(/^inline/), 'x-notes-user': me.id, 'x-content-type-options': 'nosniff', 'content-length': '11' });
    expect(await pendingUploads()).toMatchObject([{ id: file.id, name: '離線照片.png', size: 11 }]);
    expect(await unsyncedWork()).toMatchObject({ uploads: 1, total: 1 });
    online(true);
    const sent = stubApi(call => call.path === '/api/files' ? { status: 201, json: { id: file.id } } : undefined);
    await sendUploads(me.id);
    const form = sent[0]!.body as FormData;
    expect(sent).toHaveLength(1);
    expect(form.get('id')).toBe(file.id);
    expect((form.get('file') as File).name).toBe('離線照片.png');
    expect(await pendingUploads()).toEqual([]);
    expect(stores.get(`notes-uploads-${me.id}`)!.size).toBe(0);
    expect(stores.get(`notes-files-${me.id}`)!.has(file.url)).toBe(true);
    await sendUploads(me.id);
    expect(sent).toHaveLength(1);
  });

  it('holds back a note that shows a file the server refused, until that is settled', async () => {
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    const cached = await cachePage(pageOf('page'));
    const other = await cachePage(pageOf('page'));
    await saveLocalContent(cached.page.id, [{ id: 'image', props: { url: file.url } }], cached.localRevision);
    await saveLocalContent(other.page.id, [{ id: 'text' }], other.localRevision);
    online(true);
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return { status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } };
      if (call.method === 'PUT') return { json: { ...other, page: { ...other.page, version: 2, content: (call.body as { content: unknown[] }).content } } };
      return undefined;
    });
    await syncNotes({ force: true });
    // Only the note without the attachment went out; no other device gets a note with a missing file.
    expect(calls.filter(call => call.method === 'PUT').map(call => call.path)).toEqual([`/api/offline/pages/${other.page.id}`]);
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: true });
    expect(await pendingUploads()).toMatchObject([{ id: file.id, problem: '檔案超過 90 MB。' }]);
    expect(syncStatus.phase).toBe('pending');
    // The limit the server reported is remembered for files added after an offline reload.
    expect(await readLocal(`upload-limit:${me.id}`)).toBe(90 * 1024 * 1024);
  });

  it('serves an unsafe type as a sandboxed download, and reports what cannot be kept or uploaded', async () => {
    stubApi(worker);
    const html = await queueUpload(fileOf(['<script>alert(1)</script>'], 'x.html', 'text/html'), uuid());
    expect(Object.fromEntries(stores.get(`notes-uploads-${me.id}`)!.get(html.url)!.headers)).toMatchObject({ 'content-type': 'application/octet-stream', 'content-disposition': expect.stringMatching(/^attachment/), 'content-security-policy': 'sandbox' });
    await expect(queueUpload(fileOf([], 'empty.txt'), uuid())).rejects.toThrow('檔案是空的');
    await expect(queueUpload(png(), uuid(), 5)).rejects.toThrow(/超過/);
    // Online uploads still fail visibly when the server refuses them; a cover never waits on the device.
    online(true);
    stubApi(() => ({ status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } }));
    const picked = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '線上照片.png', { type: 'image/png' });
    await expect(uploadFile(picked(), { offline: true })).rejects.toThrow('檔案超過 90 MB。');
    stubApi(() => 'offline');
    await expect(uploadFile(picked())).rejects.toThrow(/無法連線/);
    expect(await pendingUploads()).toHaveLength(1);
    // The browser dropped the bytes: the upload is reported instead of silently vanishing.
    stores.get(`notes-uploads-${me.id}`)!.clear();
    await sendUploads(me.id);
    expect(await pendingUploads()).toMatchObject([{ id: html.id, problem: expect.stringContaining('已遺失') }]);
    // An offline interface from before this feature does not answer the address: refused, with nothing left behind.
    stubApi(() => ({ status: 503 }));
    await expect(queueUpload(png(), uuid())).rejects.toThrow(/需要更新/);
    expect(stores.get(`notes-uploads-${me.id}`)!.size).toBe(0);
    expect(await pendingUploads()).toHaveLength(1);
    Reflect.deleteProperty(navigator, 'serviceWorker');
    await expect(queueUpload(png(), uuid())).rejects.toThrow(/尚未啟用離線介面/);
  });

  it('creates a row added offline before uploading the file that was added to it in a shared database', async () => {
    stubApi(worker);
    const added = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    // Somebody else's database: the file is sent with the row it belongs to, and the server checks that row.
    const file = await uploadFile(png(), { offline: true, pageId: added });
    await saveLocalContent(added, [{ id: 'image', props: { url: file.url } }], (await offlineNote(added))!.revision);
    online(true);
    let created = false;
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/offline/ops') { created = true; return { json: { row: row({ id: added, title: '離線新增', values: {} }) } }; }
      if (call.path === '/api/files') return created ? { status: 201, json: { id: file.id } } : { status: 404, json: { error: { code: 'not_found', message: '找不到頁面。' } } };
      if (call.method === 'PUT') return { json: { ...pageOf('row', added, 2), page: { ...pageOf('row', added, 2).page, content: (call.body as { content: unknown[] }).content } } };
      return undefined;
    });
    await syncNotes({ force: true });
    const order = calls.filter(call => call.method !== 'GET').map(call => call.path);
    expect(order).toEqual(['/api/offline/ops', '/api/files', `/api/offline/pages/${added}`]);
    expect((calls.find(call => call.path === '/api/files')!.body as FormData).get('pageId')).toBe(added);
    expect(await pendingUploads()).toEqual([]);
    expect(await queuedOps()).toEqual([]);
    expect(await offlineNote(added)).toMatchObject({ pending: false, local: { page: { content: [{ id: 'image', props: { url: file.url } }] } } });
    expect(await unsyncedWork()).toMatchObject({ total: 0 });
  });

  it('lets a file wait for the row it was added to, and sends it by itself once the row exists on the server', async () => {
    stubApi(worker);
    const added = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    const file = await uploadFile(png(), { offline: true, pageId: added });
    online(true);
    let accept = false;
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/offline/ops') return accept ? { json: { row: row({ id: added, title: '離線新增', values: {} }) } } : { status: 409, json: { error: { code: 'conflict', message: '每個資料庫最多 5,000 列。' } } };
      if (call.path === '/api/files') return { status: 201, json: { id: file.id } };
      return undefined;
    });
    await syncNotes({ force: true });
    // The row was refused. Its file is not sent to be refused as well, and is not marked as failed.
    expect(calls.some(call => call.path === '/api/files')).toBe(false);
    const waiting = await pendingUploads();
    expect(waiting).toMatchObject([{ id: file.id, pageId: added }]);
    expect(waiting[0]!.problem).toBeUndefined();
    // Nothing can be sent while the row waits for the user: the next sync has no reason to run for the file.
    const before = calls.length;
    await syncNotes();
    expect(calls.length).toBe(before);
    accept = true;
    await retryOp((await queuedOps())[0]!.key);
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method !== 'GET').map(call => call.path).slice(-2)).toEqual(['/api/offline/ops', '/api/files']);
    expect(await pendingUploads()).toEqual([]);
    expect(await queuedOps()).toEqual([]);
  });

  it('keeps a file for a row the server does not have yet on this device, also while the server can be reached', async () => {
    const added = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    online(true);
    // The row's "create" is still waiting (held back by an earlier refusal, say): the server would answer "not found".
    const calls = stubApi(call => call.path.startsWith('/api/files/') ? worker(call) : call.path === '/api/files' ? { status: 404, json: { error: { code: 'not_found', message: '找不到頁面。' } } } : undefined);
    const file = await uploadFile(png(), { offline: true, pageId: added });
    expect(file).toMatchObject({ queued: true });
    expect(calls.some(call => call.path === '/api/files')).toBe(false);
    expect(await pendingUploads()).toMatchObject([{ id: file.id, pageId: added }]);
  });

  it('does not send a note ahead of a file that was added to it while the sync was under way', async () => {
    stubApi(worker);
    const first = await cachePage(pageOf('page')), second = await cachePage(pageOf('page'));
    await saveLocalContent(first.page.id, [{ id: 'text' }], first.localRevision);
    await saveLocalContent(second.page.id, [{ id: 'text' }], second.localRevision);
    online(true);
    const answer = (call: Call): Answer => {
      if (call.path.startsWith('/api/files/')) return worker(call);
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return { status: 201, json: {} };
      if (call.method === 'PUT') { const id = call.path.split('/').pop() as ReturnType<typeof uuid>; return { json: { ...pageOf('page', id, 2), page: { ...pageOf('page', id, 2).page, content: (call.body as { content: unknown[] }).content } } }; }
      return undefined;
    };
    const calls = stubApi(answer);
    // While the first note is on its way, a picture is added to the other one (the files of this sync were sent already).
    const fetcher = vi.mocked(fetch).getMockImplementation()!;
    let other: string | undefined, picture = '';
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (init?.method === 'PUT' && !other) {
        other = String(path).endsWith(first.page.id) ? second.page.id : first.page.id;
        picture = (await queueUpload(png(), uuid())).url;
        await saveLocalContent(other, [{ id: 'image', props: { url: picture } }], (await offlineNote(other))!.revision);
      }
      return fetcher(path, init);
    });
    await syncNotes({ force: true });
    const sent = () => calls.filter(call => call.method === 'PUT').map(call => call.path.split('/').pop());
    expect(sent()).toHaveLength(1);
    expect(sent()).not.toContain(other);
    expect(await offlineNote(other!)).toMatchObject({ pending: true, local: { page: { content: [{ id: 'image', props: { url: picture } }] } } });
    expect((await offlineNote(other!))!.sending).toBeUndefined();
    // The next sync sends the file first, then the note that shows it.
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method !== 'GET').map(call => call.path).slice(-2)).toEqual(['/api/files', `/api/offline/pages/${other}`]);
    expect(await unsyncedWork()).toMatchObject({ total: 0 });
  });

  it('does not send an explicit overwrite ahead of a file it shows either, and sends that very operation once the file is there', async () => {
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    const cached = await cachePage(pageOf('page'));
    online(true);
    let accept = false;
    const calls = stubApi(call => {
      if (call.path.startsWith('/api/files/')) return worker(call);
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return accept ? { status: 201, json: {} } : { status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } };
      if (call.method === 'GET' && call.path === `/api/pages/${cached.page.id}`) return { json: { ...cached, page: { ...cached.page, version: 2 } } };
      if (call.method === 'PUT') return { json: { ...cached, page: { ...cached.page, version: 3, content: (call.body as { content: unknown[] }).content } } };
      return undefined;
    });
    // "Overwrite with my text" fixes the operation on the spot, as every version of the interface does: whichever
    // tab sends it, it is this id with this text, marked as an overwrite (the server keeps what it replaces).
    const resolved = await resolveLocalNote(cached.page.id, 'overwrite', [{ id: 'image', props: { url: file.url } }]);
    await syncNotes({ force: true });
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method === 'PUT')).toEqual([]);
    const waiting = (await offlineNote(cached.page.id))!;
    expect(waiting).toMatchObject({ pending: true, sending: { input: { overwrite: true, baseVersion: 2, content: [{ id: 'image', props: { url: file.url } }] } } });
    expect(waiting.problem).toBeUndefined();
    // More is typed, the picture stays: there is still nothing that could be sent, and nothing to ask.
    await saveLocalContent(cached.page.id, [{ id: 'image', props: { url: file.url } }, { id: 'more' }], resolved.localRevision);
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method === 'PUT')).toEqual([]);
    expect((await offlineNote(cached.page.id))!.problem).toBeUndefined();
    // Once the file is on the server the same operation goes out, followed by what was typed since.
    accept = true;
    await retryUpload((await pendingUploads())[0]!);
    await syncNotes({ force: true });
    await syncNotes({ force: true });
    const puts = calls.filter(call => call.method === 'PUT').map(call => call.body as { operationId: string; overwrite: boolean; content: unknown[] });
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ operationId: waiting.sending!.input.operationId, overwrite: true, content: [{ id: 'image', props: { url: file.url } }] });
    expect(puts[1]).toMatchObject({ overwrite: false, content: [{ id: 'image', props: { url: file.url } }, { id: 'more' }] });
    expect(puts[1]!.operationId).not.toBe(puts[0]!.operationId);
    expect(await unsyncedWork()).toMatchObject({ total: 0 });
  });

  it('never sends two texts under one operation id', async () => {
    const cached = await cachePage(pageOf('page'));
    online(true);
    const sent: { operationId: string; content: unknown[] }[] = [];
    let lose = true;
    stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.method === 'GET' && call.path === `/api/pages/${cached.page.id}`) return { json: { ...cached, page: { ...cached.page, version: 2 } } };
      if (call.method !== 'PUT') return undefined;
      const body = call.body as { operationId: string; content: unknown[] };
      sent.push({ operationId: body.operationId, content: body.content });
      // The first request reaches nobody (the connection drops): what was fixed for it is sent again as it was.
      if (lose) { lose = false; return 'offline'; }
      return { json: { ...cached, page: { ...cached.page, version: 2 + sent.length, content: body.content } } };
    });
    const resolved = await resolveLocalNote(cached.page.id, 'overwrite', [{ id: 'first' }]);
    await syncNotes({ force: true });
    await saveLocalContent(cached.page.id, [{ id: 'second' }], resolved.localRevision);
    await syncNotes({ force: true });
    await syncNotes({ force: true });
    const texts = new Map<string, Set<string>>();
    for (const item of sent) texts.set(item.operationId, (texts.get(item.operationId) ?? new Set()).add(JSON.stringify(item.content)));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect([...texts.values()].every(set => set.size === 1)).toBe(true);
    // The repeat carried the first text; what was written since went out as an operation of its own.
    expect(sent.map(item => JSON.stringify(item.content))).toEqual([JSON.stringify([{ id: 'first' }]), JSON.stringify([{ id: 'first' }]), JSON.stringify([{ id: 'second' }])]);
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: false });
    expect(await unsyncedWork()).toMatchObject({ total: 0 });
  });

  it('asks the user about a text that an earlier version fixed with a waiting file, once the draft has moved on', async () => {
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    const cached = await cachePage(pageOf('page'));
    const image = [{ id: 'image', props: { url: file.url } }];
    const draft = await saveLocalContent(cached.page.id, image, cached.localRevision);
    // As 1.1.15 left it after "overwrite with my text": fixed on the spot, never sent because the file was refused.
    await updateLocal<Record<string, unknown>>(`page:${me.id}:${cached.page.id}`, current => ({ ...current!, sending: { revision: draft.localRevision, input: { operationId: uuid(), baseVersion: 1, baseTitle: '標題', parentId: null, title: '標題', content: image, overwrite: true, repeatAware: true } } }));
    online(true);
    const calls = stubApi(call => {
      if (call.path.startsWith('/api/files/')) return worker(call);
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return { status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } };
      if (call.method === 'GET' && call.path === `/api/pages/${cached.page.id}`) return { json: { ...cached, page: { ...cached.page, version: 4 } } };
      if (call.method === 'PUT') return { json: { ...cached, page: { ...cached.page, version: 5, content: (call.body as { content: unknown[] }).content } } };
      return undefined;
    });
    // The same text still: it simply waits for its file, without a word.
    await syncNotes({ force: true });
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: true, sending: { input: { content: image } } });
    expect((await offlineNote(cached.page.id))!.problem).toBeUndefined();
    // The picture is taken out of the note. The old text is not sent, and is not silently dropped either.
    await saveLocalContent(cached.page.id, [{ id: 'text' }], draft.localRevision);
    await syncNotes({ force: true });
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method === 'PUT')).toEqual([]);
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: true, problem: expect.stringContaining('尚未上傳的附件'), conflict: { version: 1 }, local: { page: { content: [{ id: 'text' }] } } });
    // The user chooses their text: it goes out over the page as it is on the server now.
    await resolveLocalNote(cached.page.id, 'overwrite');
    await syncNotes({ force: true });
    const puts = calls.filter(call => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ overwrite: true, baseVersion: 4, content: [{ id: 'text' }] });
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: false, base: { page: { version: 5 } } });
  });

  it('asks the user again when the refused file was taken out of the text after an overwrite was fixed with it', async () => {
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    const cached = await cachePage(pageOf('page'));
    online(true);
    let version = 2;
    const calls = stubApi(call => {
      if (call.path.startsWith('/api/files/')) return worker(call);
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return { status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } };
      if (call.method === 'GET' && call.path === `/api/pages/${cached.page.id}`) return { json: { ...cached, page: { ...cached.page, version } } };
      if (call.method === 'PUT') return { json: { ...cached, page: { ...cached.page, version: version + 1, content: (call.body as { content: unknown[] }).content } } };
      return undefined;
    });
    const resolved = await resolveLocalNote(cached.page.id, 'overwrite', [{ id: 'image', props: { url: file.url } }]);
    await syncNotes({ force: true });
    const fixed = (await offlineNote(cached.page.id))!.sending!;
    // The file stays refused; the user takes the picture out of the note instead.
    await saveLocalContent(cached.page.id, [{ id: 'text' }], resolved.localRevision);
    await syncNotes({ force: true });
    await syncNotes({ force: true });
    // The text that was fixed is not sent, and it is not rewritten or dropped behind the user's back: they are asked.
    expect(calls.filter(call => call.method === 'PUT')).toEqual([]);
    const asked = (await offlineNote(cached.page.id))!;
    expect(asked).toMatchObject({ pending: true, problem: expect.stringContaining('尚未上傳的附件'), conflict: { version: 2 }, local: { page: { content: [{ id: 'text' }] } } });
    expect(asked.sending).toEqual(fixed);
    // Somebody else has saved meanwhile; the user chooses their text again, over the page as it is by now.
    version = 6;
    await resolveLocalNote(cached.page.id, 'overwrite');
    await syncNotes({ force: true });
    const puts = calls.filter(call => call.method === 'PUT').map(call => call.body as { operationId: string });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ overwrite: true, baseVersion: 6, content: [{ id: 'text' }] });
    expect(puts[0]!.operationId).not.toBe(fixed.input.operationId);
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: false, base: { page: { version: 7 } } });
    expect((await offlineNote(cached.page.id))!.sending).toBeUndefined();
    // The refused file is still listed for the user to retry or discard; nothing shows it any more.
    expect(await pendingUploads()).toMatchObject([{ id: file.id, problem: '檔案超過 90 MB。' }]);
  });

  it('fixes nothing to send for a note that has to wait for a file, so no other tab can pick it up', async () => {
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    const cached = await cachePage(pageOf('page'));
    await saveLocalContent(cached.page.id, [{ id: 'image', props: { url: file.url } }], cached.localRevision);
    online(true);
    stubApi(call => {
      if (call.path.startsWith('/api/files/')) return worker(call);
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path === '/api/files') return { status: 413, json: { error: { code: 'payload_too_large', message: '檔案超過 90 MB。' } } };
      return undefined;
    });
    // Every state the note passes through while the sync runs, as another tab would read it.
    const seen: unknown[] = [];
    const watch = () => { void offlineNote(cached.page.id).then(note => seen.push(note?.sending)); };
    window.addEventListener(OFFLINE_EVENT, watch);
    await syncNotes({ force: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    window.removeEventListener(OFFLINE_EVENT, watch);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(sending => sending === undefined)).toBe(true);
    expect(await offlineNote(cached.page.id)).toMatchObject({ pending: true });
  });

  it('holds a discussion on a row made here until the row exists on the server', async () => {
    const added = uuid(), annotationId = uuid();
    await submitOp({ type: 'row.create', databaseId, rowId: added, title: '離線新增', values: {} });
    await createLocalRow(databaseId, added, '離線新增');
    online(true);
    const calls = stubApi(call => {
      if (call.path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (call.path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024, databases: [{ id: databaseId, stamp: 's1' }], annotations: [] } satisfies OfflineManifest };
      if (call.path !== '/api/offline/ops') return undefined;
      return (call.body as { op: OfflineOp }).op.type === 'row.create' ? { json: { row: row({ id: added, title: '離線新增', values: {} }) } }
        : { json: { annotation: { id: annotationId, quote: '字', blockIds: ['b'], messages: [], reactions: ['🎉'], resolved: false, version: 1, createdAt: 1, updatedAt: 1 } } };
    });
    // Even online it is not sent ahead of the row: the server does not know the page yet.
    const result = await submitOp({ type: 'annotation.create', pageId: added, annotationId, messageId: uuid(), quote: '字', blockIds: ['b'], emoji: '🎉', at: 1 });
    expect(result).toMatchObject({ queued: true });
    expect(ops(calls)).toEqual([]);
    await syncNotes({ force: true });
    expect(ops(calls).map(item => item.op.type)).toEqual(['row.create', 'annotation.create']);
    expect(await queuedOps()).toEqual([]);
  });

  it('does not keep an uploaded file that is larger than the attachment space allowed on this device', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage } } });
    stubApi(worker);
    const file = await uploadFile(png(), { offline: true });
    // As if the file were larger than the default 500 MB of attachment space.
    await updateLocal<{ size: number }>(`upload:${me.id}:${file.id}`, current => ({ ...current!, size: 600 * 1024 * 1024 }));
    online(true);
    stubApi(call => call.path === '/api/files' ? { status: 201, json: {} } : undefined);
    await sendUploads(me.id);
    // Uploaded and no longer waiting, but not put where it would push every other kept file out.
    expect(await pendingUploads()).toEqual([]);
    expect(stores.get(`notes-files-${me.id}`)?.size ?? 0).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('asks the offline interface to keep the attachment space within its limit after uploads were moved into it', async () => {
    const postMessage = vi.fn();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage } } });
    stubApi(worker);
    await uploadFile(png(), { offline: true });
    online(true);
    stubApi(call => call.path === '/api/files' ? { status: 201, json: {} } : undefined);
    await sendUploads(me.id);
    expect(stores.get(`notes-files-${me.id}`)!.size).toBe(1);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'notes:trim-files' });
    // Nothing was moved this time: nothing to trim.
    await sendUploads(me.id);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('accounts on a shared browser', () => {
  it('keep each other’s unsynced changes and uploads, and drop only clean copies', async () => {
    await submitOp(edit('我的離線修改'));
    const other = account('other');
    await rememberUser(other);
    expect(await queuedOps()).toEqual([]);
    expect(await localDatabase(databaseId)).toBeUndefined();
    expect(await readLocal(`db:${me.id}:${databaseId}`)).toBeUndefined();
    await storeDatabase(other.id, { stamp: 'o1', meta: meta(), rows: [] });
    await forgetOfflineData();
    expect(await readLocal(`db:${other.id}:${databaseId}`)).toBeUndefined();
    await rememberUser(me);
    expect((await queuedOps()).map(item => item.op)).toEqual([edit('我的離線修改')]);
    expect(await unsyncedWork()).toMatchObject({ changes: 1 });
  });
});
