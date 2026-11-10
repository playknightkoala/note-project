import type { Annotation } from '@shared/annotations';
import type { DatabaseDto } from '@shared/database';
import { applyAnnotationOp, applyDatabaseOp, describeOp, isDatabaseOp, isSchemaOp, opScope } from '@shared/offline';
import type { DatabaseSnapshot, DatabaseSnapshotDto, OfflineOp, OfflineOpResult } from '@shared/offline';
import { newId } from '@shared/ids';
import { ApiError, api, isApiError } from '../api/client.ts';
import { annotationsKey, databaseKey, offlineActor, offlineOwner, opPrefix, pageKey } from './owner.ts';
import { listLocal, readLocal, removeLocal, updateLocal } from './storage.ts';

/**
 * Changes to databases and discussions that could not be sent yet. Each one is a small, repeatable operation; the
 * server carries it out at most once. What the user sees is the last downloaded copy with these changes on top.
 */
export interface QueuedOp {
  key: string; id: string; userId: string; op: OfflineOp; force: boolean; createdAt: number;
  /** Why the server refused it. A refused operation holds back later ones for the same database or page. */
  problem?: string;
  /** Refused because the same thing changed elsewhere; the user may apply it anyway. */
  conflict?: boolean;
}
export interface LocalDatabase extends DatabaseSnapshot { stamp: string }
export interface LocalAnnotations { pageId: string; stamp: string; items: Annotation[] }

/** Fired in this tab with the scope (`db:<id>` or `ann:<pageId>`) whose queue or downloaded copy changed. */
export const OUTBOX_EVENT = 'notes:outbox-change';
const announce = (scope: string) => window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: scope }));
export const transient = (error: unknown) => isApiError(error) && (error.status === 0 || error.status >= 500);
/**
 * The whole sync has to stop and try again later: no connection, no session, or a session that is no longer the one
 * the sync started with (its CSRF token is refused). None of these says anything about the item being sent.
 */
export const mustStop = (error: unknown) => transient(error) || isApiError(error, 401) || (isApiError(error, 403) && error.code === 'csrf');

const writer = newId();
let counter = 0;
/** Sorts by creation time, also across tabs. */
const nextKey = (userId: string) => `${opPrefix(userId)}${String(Date.now()).padStart(15, '0')}-${String(counter++).padStart(6, '0')}-${writer}`;

export async function queuedOps(userId = offlineOwner()): Promise<QueuedOp[]> {
  return userId ? listLocal<QueuedOp>(opPrefix(userId)) : [];
}
/** For deciding what to show: where this device cannot store anything, nothing is waiting either. */
const waiting = (userId: string) => queuedOps(userId).catch((): QueuedOp[] => []);
const inScope = async (userId: string, scope: string) => (await waiting(userId)).filter(item => opScope(item.op) === scope);
export const hasQueued = async (scope: string): Promise<boolean> => { const owner = offlineOwner(); return !!owner && (await inScope(owner, scope)).length > 0; };

/** An operation on a page that exists only on this device has to wait until the page itself has been uploaded. */
async function pageNotUploaded(userId: string, op: OfflineOp): Promise<boolean> {
  return !isDatabaseOp(op) && (await readLocal<{ isNew?: boolean }>(pageKey(userId, op.pageId)).catch(() => undefined))?.isNew === true;
}

// ---- Downloaded copies ----

export async function storeDatabase(userId: string, snapshot: Pick<DatabaseSnapshotDto, 'stamp' | 'meta' | 'rows'>): Promise<void> {
  await updateLocal<LocalDatabase>(databaseKey(userId, snapshot.meta.id), () => ({ stamp: snapshot.stamp, meta: snapshot.meta, rows: snapshot.rows }));
  announce(`db:${snapshot.meta.id}`);
}
export async function storeAnnotations(userId: string, pageId: string, stamp: string, items: Annotation[]): Promise<void> {
  await updateLocal<LocalAnnotations>(annotationsKey(userId, pageId), () => ({ pageId, stamp, items }));
  announce(`ann:${pageId}`);
}
/** Keeps the list the server just returned, quietly: nothing is re-read because of it, and the sync stamp is left alone. */
export async function rememberAnnotations(pageId: string, items: Annotation[]): Promise<void> {
  const owner = offlineOwner();
  if (!owner) return;
  await updateLocal<LocalAnnotations>(annotationsKey(owner, pageId), current => current && JSON.stringify(current.items) === JSON.stringify(items) ? current : { pageId, stamp: current?.stamp ?? '', items }).catch(() => undefined);
}
export async function forgetDatabase(userId: string, id: string): Promise<void> {
  await updateLocal<LocalDatabase>(databaseKey(userId, id), () => undefined);
  announce(`db:${id}`);
}
export async function forgetAnnotations(userId: string, pageId: string): Promise<void> {
  await updateLocal<LocalAnnotations>(annotationsKey(userId, pageId), () => undefined);
  announce(`ann:${pageId}`);
}
export const storedDatabases = (userId: string) => listLocal<LocalDatabase>(`db:${userId}:`);
export const storedAnnotations = (userId: string) => listLocal<LocalAnnotations>(`annotations:${userId}:`);
export const storedDatabase = (userId: string, id: string) => readLocal<LocalDatabase>(databaseKey(userId, id));
export const storedAnnotationStamp = async (userId: string, pageId: string) => (await readLocal<LocalAnnotations>(annotationsKey(userId, pageId)))?.stamp;

/** The database as this device knows it: the downloaded copy with every waiting change applied. */
export async function localDatabase(id: string): Promise<DatabaseSnapshot | undefined> {
  const owner = offlineOwner();
  const base = owner ? await storedDatabase(owner, id).catch(() => undefined) : undefined;
  if (!owner || !base) return undefined;
  let view: DatabaseSnapshot = { meta: base.meta, rows: base.rows };
  for (const item of await waiting(owner)) if (isDatabaseOp(item.op) && item.op.databaseId === id) view = applyDatabaseOp(view, item.op, item.createdAt);
  return view;
}
/** The discussions of a page as this device knows them. A page without a downloaded list has none. */
export async function localAnnotations(pageId: string): Promise<Annotation[]> {
  const owner = offlineOwner();
  if (!owner) return [];
  let items = (await readLocal<LocalAnnotations>(annotationsKey(owner, pageId)).catch(() => undefined))?.items ?? [];
  for (const item of await waiting(owner)) if (!isDatabaseOp(item.op) && item.op.pageId === pageId) items = applyAnnotationOp(items, item.op, offlineActor());
  return items;
}

/** Folds a change the server has carried out into the downloaded copy, taking the server's answer over the estimate. */
async function absorb(userId: string, op: OfflineOp, result: OfflineOpResult): Promise<void> {
  if (isDatabaseOp(op)) {
    await updateLocal<LocalDatabase>(databaseKey(userId, op.databaseId), current => {
      if (!current) return current;
      const next = applyDatabaseOp(current, op, Date.now());
      const rowId = 'rowId' in op ? op.rowId : undefined;
      const rows = rowId === undefined ? next.rows
        : result.row ? (next.rows.some(row => row.id === rowId) ? next.rows.map(row => row.id === rowId ? result.row! : row) : [...next.rows, result.row])
          : next.rows.filter(row => row.id !== rowId);
      return { stamp: current.stamp, meta: result.database ?? next.meta, rows };
    });
    // The row now exists on the server, so its page may be synced like any other.
    if (op.type === 'row.create') await updateLocal<{ localOnly?: boolean }>(pageKey(userId, op.rowId), current => current?.localOnly ? { ...current, localOnly: undefined } : current);
  } else {
    await updateLocal<LocalAnnotations>(annotationsKey(userId, op.pageId), current => {
      const items = applyAnnotationOp(current?.items ?? [], op, offlineActor());
      return { pageId: op.pageId, stamp: current?.stamp ?? '', items: result.annotation ? [...items.filter(item => item.id !== result.annotation!.id), result.annotation].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) : items };
    });
  }
}

const send = (item: Pick<QueuedOp, 'id' | 'force' | 'op'>) => api<OfflineOpResult>('POST', '/api/offline/ops', { json: { operationId: item.id, force: item.force, op: item.op } });

/** What a waiting operation is expected to produce, read from the local view. */
async function expected(op: OfflineOp): Promise<OfflineOpResult> {
  if (isDatabaseOp(op)) {
    const view = await localDatabase(op.databaseId);
    if (!view) return {};
    const row = 'rowId' in op ? view.rows.find(item => item.id === op.rowId) : undefined;
    return 'rowId' in op ? (row ? { row } : {}) : { database: view.meta };
  }
  const annotation = (await localAnnotations(op.pageId)).find(item => item.id === op.annotationId);
  return annotation ? { annotation } : op.type === 'annotation.delete' ? { deletedId: op.annotationId } : {};
}

const chains = new Map<string, Promise<unknown>>();
/** One operation per scope at a time, in the order they were made. */
function inOrder<T>(scope: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(scope) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => {});
  chains.set(scope, settled);
  void settled.then(() => { if (chains.get(scope) === settled) chains.delete(scope); });
  return run;
}

export type SubmittedOp = OfflineOpResult & { /** Stored on this device; it reaches the server at the next sync. */ queued: boolean };

/**
 * Carries out one change. Online, with nothing waiting for the same database or page, it goes straight to the server
 * and a refusal is reported to the caller. Otherwise it is stored here first and shown from the local view.
 */
export function submitOp(op: OfflineOp): Promise<SubmittedOp> {
  const owner = offlineOwner();
  const scope = opScope(op);
  return inOrder(scope, async () => {
    const id = newId();
    // Without an account to keep data for, there is nowhere to queue: the change is sent now or fails visibly.
    if (!owner) return { ...await send({ id, force: false, op }), queued: false };
    if (navigator.onLine !== false && (await inScope(owner, scope)).length === 0 && !(await pageNotUploaded(owner, op))) {
      try {
        const result = await send({ id, force: false, op });
        if (offlineOwner() === owner) { await absorb(owner, op, result).catch(() => {}); announce(scope); }
        return { ...result, queued: false };
      } catch (error) {
        // No answer does not mean it was not carried out: the same operation id is queued, so it cannot apply twice.
        if (!transient(error)) throw error;
      }
    }
    if (offlineOwner() !== owner) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟頁面。');
    const item: QueuedOp = { key: nextKey(owner), id, userId: owner, op, force: false, createdAt: Date.now() };
    await updateLocal<QueuedOp>(item.key, () => item);
    announce(scope);
    return { ...await expected(op), queued: true };
  });
}

/**
 * Sends the waiting operations in order. A refused one stays in the list with its reason and holds back the rest of
 * its own database or page; connection and sign-in failures are thrown so the whole sync retries later.
 */
export async function sendOps(userId: string): Promise<void> {
  const held = new Set<string>();
  for (const listed of await queuedOps(userId)) {
    if (offlineOwner() !== userId) return;
    const scope = opScope(listed.op);
    if (held.has(scope)) continue;
    // Another operation in this scope may have changed this one (a structure version) since the list was read.
    const item = await readLocal<QueuedOp>(listed.key);
    if (!item) continue;
    if (item.problem || await pageNotUploaded(userId, item.op)) { held.add(scope); continue; }
    try {
      const result = await inOrder(scope, () => send(item));
      await absorb(userId, item.op, result);
      if (isSchemaOp(item.op) && result.database) await carryVersion(userId, scope, item.key, result.database);
      await updateLocal<QueuedOp>(item.key, () => undefined);
    } catch (error) {
      if (mustStop(error)) throw error;
      await updateLocal<QueuedOp>(item.key, current => current && { ...current, problem: error instanceof Error ? error.message : '同步失敗', conflict: isApiError(error, 409) && error.code === 'version_conflict' });
      held.add(scope);
    }
    announce(scope);
  }
}

/**
 * Later structure changes were made on top of the one just carried out, so they continue from the version it
 * produced. One made on an older structure keeps its own version and is reported as a conflict when its turn comes.
 */
async function carryVersion(userId: string, scope: string, afterKey: string, database: DatabaseDto): Promise<void> {
  for (const later of await inScope(userId, scope)) {
    if (later.key <= afterKey || !isSchemaOp(later.op) || later.op.baseVersion !== database.version - 1) continue;
    await updateLocal<QueuedOp>(later.key, current => current && isSchemaOp(current.op) ? { ...current, op: { ...current.op, baseVersion: database.version } } : current);
  }
}

/** Tries a refused operation again; with `force` the user has chosen to apply it over the change made elsewhere. */
export async function retryOp(key: string, force = false): Promise<void> {
  const item = await updateLocal<QueuedOp>(key, current => current && { ...current, problem: undefined, conflict: undefined, force: current.force || force });
  if (item) announce(opScope(item.op));
}

/** Gives a waiting change up. With a row that only this device created go its later changes, its page and the discussions on it. */
export async function discardOp(key: string): Promise<void> {
  const item = await readLocal<QueuedOp>(key);
  if (!item) return;
  const rowId = item.op.type === 'row.create' ? item.op.rowId : undefined;
  const dependent = (candidate: string, value: unknown): boolean => {
    if (rowId === undefined) return false;
    if (candidate === pageKey(item.userId, rowId)) return true;
    const op = candidate.startsWith(opPrefix(item.userId)) ? (value as QueuedOp).op : undefined;
    return !!op && (isDatabaseOp(op) ? op.type === 'row.update' && op.rowId === rowId : op.pageId === rowId);
  };
  await removeLocal((candidate, value) => candidate === key || dependent(candidate, value));
  announce(opScope(item.op));
}

export const describeQueued = (item: QueuedOp): string => describeOp(item.op);
