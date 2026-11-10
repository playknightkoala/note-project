import type { PageHeadDto, PageNode, PageResponse, SessionDto, TreeDto, UserDto } from '@shared/api';
import { summarizePage } from '@shared/offline';
import type { DatabaseSnapshotDto, OfflineManifest, SyncNoteInput } from '@shared/offline';
import type { IncomingShareDto, SharesDto } from '@shared/shares';
import type { Annotation } from '@shared/annotations';
import { ApiError, api, isApiError, setCsrfToken } from '../api/client.ts';
import { announceOfflineChange, listLocal, readLocal, removeLocal, updateLocal } from './storage.ts';
import { fileCache, pageKey, setOfflineOwner, sharedKey, uploadCache } from './owner.ts';
import { forgetAnnotations, forgetDatabase, mustStop, queuedOps, sendOps, storeAnnotations, storeDatabase, storedAnnotationStamp, storedAnnotations, storedDatabase, storedDatabases, transient } from './outbox.ts';
import { pendingUploads, sendUploads } from './uploads.ts';

export { transient };

export interface LocalPageResponse extends PageResponse { localRevision?: string }
export interface LocalHead extends PageHeadDto { localRevision?: string; queued?: boolean }
export interface OfflineNote {
  userId: string;
  base: PageResponse;
  local: PageResponse;
  revision: string;
  writer: string;
  isNew: boolean;
  pending: boolean;
  sending?: { input: SyncNoteInput; revision: string };
  problem?: string;
  conflict?: PageHeadDto;
  removed?: boolean;
  /** A row made on this device whose "create row" change has not reached the server yet; its page cannot be synced before that. */
  localOnly?: boolean;
}
/** Kinds whose text is written on this device first and synced afterwards. A database page has no text of its own. */
export const hasDraft = (kind: PageResponse['page']['kind']): boolean => kind !== 'database';
const writer = crypto.randomUUID();
let user: UserDto | null = null;
function setUser(value: UserDto | null): void { user = value; setOfflineOwner(value?.id ?? null, value?.displayName); }
let syncing: Promise<void> | undefined;
export const SYNC_EVENT = 'notes:sync-status';
export const SYNC_TREE_EVENT = 'notes:tree-synced';
export interface SyncStatus {
  phase: 'idle' | 'syncing' | 'complete' | 'pending' | 'error';
  completedAt: number | null;
  error?: string;
  maxUploadBytes?: number;
}
export let syncStatus: SyncStatus = { phase: 'idle', completedAt: null };
let nextDownloadAt = 0, retryAt = 0, failures = 0;
function setSyncStatus(status: SyncStatus): void {
  syncStatus = status;
  window.dispatchEvent(new Event(SYNC_EVENT));
}
async function restoreSyncStatus(owner: string): Promise<void> {
  nextDownloadAt = 0; retryAt = 0; failures = 0;
  const completedAt = await readLocal<number>(`synced:${owner}`).catch(() => undefined);
  // The server's upload limit as last reported, so a file added offline after a reload is still checked against it.
  const maxUploadBytes = await readLocal<number>(`upload-limit:${owner}`).catch(() => undefined);
  if (user?.id === owner) setSyncStatus({ phase: 'idle', completedAt: completedAt ?? null, ...(maxUploadBytes ? { maxUploadBytes } : {}) });
}
export let offlineStorageError: string | null = null;
const head = (note: OfflineNote): LocalHead => ({ version: note.base.page.version, title: note.local.page.title, updatedAt: note.local.page.updatedAt, localRevision: note.revision, queued: note.pending });
function storageError(error: unknown): void {
  const message = error instanceof Error ? error.message : '本機儲存無法使用。';
  if (offlineStorageError !== message) { offlineStorageError = message; announceOfflineChange(); }
}

/** Records are keyed `<kind>:<userId>[:<id>]`; the `user` record has no owner. */
const ownerOfKey = (key: string): string | undefined => /^(page|tree|synced|attachments|annotation-highlights|db|annotations|op|upload|upload-limit|shared):/.test(key) ? key.split(':')[1] : undefined;
/** Work that exists only on this device: a note draft, a row made here, a queued change, a file waiting to be uploaded. */
const isUnsyncedDraft = (key: string, value: unknown): boolean => key.startsWith('op:') || key.startsWith('upload:')
  || (key.startsWith('page:') && ((value as OfflineNote | undefined)?.pending === true || (value as OfflineNote | undefined)?.localOnly === true));

/**
 * Removes other accounts' downloaded copies and attachment caches from this browser. Their unsynced drafts are the
 * only thing kept, so the owner can still upload or export them after signing in again.
 */
async function purgeOtherAccounts(keep: string): Promise<void> {
  await removeLocal((key, value) => { const owner = ownerOfKey(key); return owner !== undefined && owner !== keep && !isUnsyncedDraft(key, value); });
  // Files waiting to be uploaded (`notes-uploads-*`) are another account's unsynced work and stay.
  if ('caches' in window) for (const name of await caches.keys()) if (name.startsWith('notes-files-') && name !== fileCache(keep)) await caches.delete(name);
}

export async function rememberUser(value: UserDto): Promise<void> {
  const changed = user?.id !== value.id;
  setUser(value);
  try { await updateLocal<UserDto>('user', () => value); offlineStorageError = null; } catch (error) { storageError(error); }
  if (changed) { await purgeOtherAccounts(value.id).catch(storageError); await restoreSyncStatus(value.id); }
}
export async function cachedUser(): Promise<UserDto | null> {
  try { setUser(await readLocal<UserDto>('user') ?? null); if (user) await restoreSyncStatus(user.id); return user; } catch (error) { storageError(error); return null; }
}
/** A known 401 revokes offline entry. Keep unsynced drafts for the same account's next login. */
export async function revokeOfflineEntry(): Promise<void> {
  setUser(null);
  setSyncStatus({ phase: 'idle', completedAt: null });
  setCsrfToken(null);
  await updateLocal('user', () => undefined).catch(storageError);
}
/** Another tab ended or replaced the session: stop acting for the old account here, without touching storage. */
export function detachOfflineUser(): void {
  setUser(null);
  nextDownloadAt = 0; retryAt = 0; failures = 0;
  setSyncStatus({ phase: 'idle', completedAt: null });
}
/**
 * Sign-out: forget this account and every clean copy on the device. Unsynced drafts that belong to a different
 * account (whose session expired here earlier) are never deleted by someone else's sign-out.
 */
export async function forgetOfflineData(): Promise<void> {
  const owner = user?.id ?? (await readLocal<UserDto>('user').catch(() => undefined))?.id;
  setUser(null);
  nextDownloadAt = 0; retryAt = 0; failures = 0;
  setSyncStatus({ phase: 'idle', completedAt: null });
  await removeLocal((key, value) => ownerOfKey(key) === owner || !isUnsyncedDraft(key, value));
  if ('caches' in window) for (const name of await caches.keys()) if (name.startsWith('notes-files-') || (owner && name === uploadCache(owner))) await caches.delete(name);
}
/** Anything on this device that the server does not have yet. Signing out or discarding the device's data would lose it. */
export async function unsyncedWork(): Promise<{ notes: number; changes: number; uploads: number; total: number }> {
  const notes = (await offlineNotes()).filter(note => note.pending).length, changes = (await queuedOps()).length, uploads = (await pendingUploads()).length;
  return { notes, changes, uploads, total: notes + changes + uploads };
}
export async function offlineNotes(): Promise<OfflineNote[]> {
  try { return user ? await listLocal<OfflineNote>(`page:${user.id}:`) : []; } catch (error) { storageError(error); return []; }
}
export async function offlineNote(id: string): Promise<OfflineNote | undefined> {
  return user ? readLocal<OfflineNote>(pageKey(user.id, id)) : undefined;
}
const localResponse = (note: OfflineNote): LocalPageResponse => ({ ...note.local, localRevision: note.revision });

export async function cachePage(response: PageResponse, expectedUserId = user?.id): Promise<LocalPageResponse> {
  const owner = user;
  if (owner?.id !== expectedUserId) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟筆記。');
  if (!owner) return response;
  try {
    const note = await updateLocal<OfflineNote>(pageKey(owner.id, response.page.id), current => {
      if (user?.id !== owner.id) throw new ApiError(401, 'unauthorized', '帳號已切換。');
      if (current?.pending || (current && current.base.page.version > response.page.version)) return current;
      // Icon, cover, favourite, position and ancestor names change without a new content version. Those must not
      // look like someone else's edit to an open editor, so the revision only changes with the text itself.
      // A row's name is one of its database cells, not part of the text that is drafted here.
      const sameText = !!current && !current.removed && current.base.page.version === response.page.version && (response.page.kind === 'row' || current.base.page.title === response.page.title)
        && JSON.stringify(current.base.page.content) === JSON.stringify(response.page.content);
      return { userId: owner.id, base: response, local: response, revision: sameText ? current.revision : crypto.randomUUID(), writer: sameText ? current.writer : '', isNew: false, pending: false };
    });
    return localResponse(note!);
  } catch (error) { if (isApiError(error, 401)) throw error; storageError(error); return response; }
}

export async function loadNote(id: string): Promise<LocalPageResponse> {
  const owner = user?.id;
  const local = await offlineNote(id).catch(() => undefined);
  if ((local?.isNew || local?.localOnly) && user?.id === owner) return localResponse(local);
  try { return await cachePage(await api<PageResponse>('GET', `/api/pages/${id}`), owner); }
  catch (error) {
    if (!transient(error)) throw error;
    if (user?.id !== owner) throw error;
    const cached = await offlineNote(id);
    if (cached?.removed && !cached.pending) throw new ApiError(404, 'not_found', '此筆記已在線上刪除，無法離線開啟。');
    if (cached) return localResponse(cached);
    throw new ApiError(0, 'internal', '此筆記尚未下載至此裝置，連線後開啟一次即可離線使用。');
  }
}

function nodeOf(note: OfflineNote): PageNode {
  const p = note.local.page;
  return { id: p.id, parentId: p.parentId, kind: p.kind, title: p.title, icon: p.icon, position: p.createdAt, isFavorite: p.isFavorite, favoritePosition: null, hasChildren: false, updatedAt: p.updatedAt };
}
export async function loadTree(): Promise<PageNode[]> {
  const owner = user;
  let nodes: PageNode[];
  try {
    nodes = (await api<TreeDto>('GET', '/api/pages/tree')).pages;
    if (user?.id !== owner?.id) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟筆記。');
    if (owner) await updateLocal<PageNode[]>(`tree:${owner.id}`, () => nodes).catch(storageError);
  } catch (error) {
    if (!transient(error)) throw error;
    nodes = owner ? await readLocal<PageNode[]>(`tree:${owner.id}`) ?? [] : [];
  }
  // Rows are listed inside their database, never in the page tree, also while their text waits to be synced.
  // Neither is somebody else's page that waits here: it belongs under 「與我共用」, not among the user's own pages.
  const pending = (await offlineNotes()).filter(n => n.pending && n.local.page.kind === 'page' && !n.local.access);
  const map = new Map(nodes.map(n => [n.id, n]));
  for (const note of pending) {
    const old = map.get(note.local.page.id);
    map.set(note.local.page.id, { ...nodeOf(note), position: old?.position ?? note.local.page.createdAt, hasChildren: old?.hasChildren ?? false });
  }
  return [...map.values()];
}

export async function createLocalNote(input: { title?: string; parentId?: string | null; kind?: 'page' | 'database'; icon?: string | null }): Promise<LocalPageResponse> {
  if (!user) throw new Error('請先登入後再使用離線筆記。');
  if (input.kind === 'database' || input.icon) throw new Error('新增資料庫或設定圖示需要連線。');
  const id = crypto.randomUUID(), at = Date.now();
  const parent = input.parentId ? await offlineNote(input.parentId) : undefined;
  if (input.parentId && (!parent || parent.local.page.kind !== 'page')) throw new Error('請先連線下載上層筆記。');
  // The server would refuse it, and the note would wait on this device for ever.
  if (parent?.local.access) throw new Error('只有擁有者可以在共用的頁面底下新增子頁面。');
  const response: PageResponse = {
    page: { id, parentId: input.parentId ?? null, kind: 'page', databaseId: null, title: input.title ?? '', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 0, isFavorite: false, trashedAt: null, createdAt: at, updatedAt: at },
    breadcrumbs: [...(parent?.local.breadcrumbs ?? []), { id, title: input.title ?? '', icon: null, kind: 'page' }],
  };
  const note: OfflineNote = { userId: user.id, base: response, local: response, revision: crypto.randomUUID(), writer, isNew: true, pending: true };
  await updateLocal<OfflineNote>(pageKey(user.id, id), () => note);
  setSyncStatus({ ...syncStatus, phase: 'pending' });
  void syncNotes();
  return localResponse(note);
}

/**
 * The page of a row that was added while its database could not reach the server. It starts at the version the server
 * gives every new row, so text written into it before the row exists there syncs as an ordinary edit afterwards.
 */
export async function createLocalRow(databaseId: string, rowId: string, title: string): Promise<void> {
  const owner = user;
  if (!owner) return;
  const database = await offlineNote(databaseId).catch(() => undefined);
  const at = Date.now();
  const response: PageResponse = {
    page: { id: rowId, parentId: databaseId, kind: 'row', databaseId, title, icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 1, isFavorite: false, trashedAt: null, createdAt: at, updatedAt: at },
    breadcrumbs: [...(database?.local.breadcrumbs ?? []), { id: rowId, title, icon: null, kind: 'row' }],
    // A row added to a shared database is reached the same way as the database itself.
    ...(database?.local.access ? { access: database.local.access } : {}),
  };
  await updateLocal<OfflineNote>(pageKey(owner.id, rowId), current => current ?? { userId: owner.id, base: response, local: response, revision: crypto.randomUUID(), writer: '', isNew: false, pending: false, localOnly: true });
}

/** The row was never created after all (the server refused it, or nothing could be stored): drop its untouched local page. */
export async function dropLocalRow(rowId: string): Promise<void> {
  const owner = user;
  if (owner) await updateLocal<OfflineNote>(pageKey(owner.id, rowId), current => current?.localOnly && !current.pending ? undefined : current).catch(() => undefined);
}

/** A row's name is one of its cells: when the cell changes, the copy of the row's page kept here shows the new name too. */
export async function renameLocalRow(rowId: string, title: string): Promise<LocalPageResponse | undefined> {
  const owner = user;
  if (!owner) return undefined;
  const rename = (response: PageResponse): PageResponse => ({ ...response, page: { ...response.page, title }, breadcrumbs: response.breadcrumbs.map(crumb => crumb.id === rowId ? { ...crumb, title } : crumb) });
  // The revision stays: this is not an edit of the text, and an open editor must not treat it as one.
  const note = await updateLocal<OfflineNote>(pageKey(owner.id, rowId), current => current && current.local.page.kind === 'row' ? { ...current, base: rename(current.base), local: rename(current.local) } : current);
  return note && localResponse(note);
}

/** Persist before networking. Revision checks prevent a stale tab from replacing another tab's local draft. */
async function editNote(id: string, change: { content?: unknown[]; title?: string }, expectedRevision?: string): Promise<OfflineNote> {
  if (!user) throw new Error('請先登入。');
  const note = await updateLocal<OfflineNote>(pageKey(user.id, id), current => {
    if (!current) throw new Error('此筆記尚未保存至本機，請先連線下載。');
    if (!hasDraft(current.local.page.kind) || (change.title !== undefined && current.local.page.kind !== 'page')) throw new Error('這個頁面的此項修改無法保存為本機草稿。');
    if (current.writer !== writer && current.revision !== expectedRevision) throw new ApiError(409, 'version_conflict', '另一個分頁已修改此裝置的草稿，請先重新載入。', { current: head(current), localConflict: true });
    return { ...current, local: { ...current.local, page: { ...current.local.page, ...change, updatedAt: Date.now() } }, revision: crypto.randomUUID(), writer, pending: true };
  });
  setSyncStatus({ ...syncStatus, phase: 'pending' });
  void syncNotes();
  return note!;
}
export async function saveLocalContent(id: string, content: unknown[], revision?: string): Promise<LocalHead> { return head(await editNote(id, { content }, revision)); }
export async function saveLocalTitle(id: string, title: string, revision?: string): Promise<LocalPageResponse> {
  return localResponse(await editNote(id, { title }, revision));
}

export const isLocalWriter = (note: OfflineNote) => note.writer === writer;

/** `waitingFiles`: addresses of attachments still on this device only. A note that refers to one is not sent before it. */
async function sendNote(owner: UserDto, id: string, waitingFiles: string[] = []): Promise<void> {
  const key = pageKey(owner.id, id);
  let note = await readLocal<OfflineNote>(key);
  if (!note?.pending || note.problem || note.localOnly || user?.id !== owner.id) return;
  if (waitingFiles.length) { const text = JSON.stringify(note.local.page.content); if (waitingFiles.some(url => text.includes(url))) return; }
  if (note.isNew && note.local.page.parentId) {
    const parent = await readLocal<OfflineNote>(pageKey(owner.id, note.local.page.parentId));
    if (parent?.isNew) {
      await sendNote(owner, parent.local.page.id, waitingFiles);
      if ((await readLocal<OfflineNote>(pageKey(owner.id, parent.local.page.id)))?.isNew) return;
    }
  }
  note = await updateLocal<OfflineNote>(key, current => {
    if (!current?.pending || current.problem || current.localOnly || current.sending) return current;
    return { ...current, sending: { revision: current.revision, input: {
      operationId: crypto.randomUUID(), baseVersion: current.isNew ? null : current.base.page.version,
      baseTitle: current.base.page.title, title: current.local.page.title, content: current.local.page.content,
      parentId: current.local.page.parentId, overwrite: false,
    } } };
  });
  const sent = note?.sending;
  if (!sent || user?.id !== owner.id) return;
  try {
    const response = await api<PageResponse>('PUT', `/api/offline/pages/${id}`, { json: sent.input, headers: { 'if-match': `"${sent.input.baseVersion ?? 0}"` } });
    await updateLocal<OfflineNote>(key, current => {
      if (!current || current.sending?.input.operationId !== sent.input.operationId) return current;
      const pending = current.revision !== sent.revision;
      return { ...current, base: response, local: pending ? { ...response, page: { ...response.page, content: current.local.page.content, title: current.local.page.title } } : response, pending, isNew: false, sending: undefined, problem: undefined, conflict: undefined };
    });
  } catch (error) {
    if (mustStop(error)) throw error;
    // A rejected operation left no receipt on the server. Unless it is a conflict (resolved explicitly), drop the
    // frozen payload so the next attempt sends the note as it is by then, e.g. after the user shortened it.
    await updateLocal<OfflineNote>(key, current => current && current.sending?.input.operationId === sent.input.operationId ? {
      ...current, problem: error instanceof Error ? error.message : '同步失敗',
      conflict: isApiError(error, 409) ? error.details?.current as PageHeadDto : undefined,
      sending: isApiError(error, 409) ? current.sending : undefined,
    } : current);
  }
}

/** Download changed pages only; pending drafts always retain their original server baseline. */
async function pullNotes(owner: UserDto): Promise<void> {
  const manifest = await api<OfflineManifest>('GET', '/api/offline/manifest');
  if (user?.id !== owner.id) return;
  if (manifest.userId !== owner.id) throw new ApiError(401, 'unauthorized', '登入帳號已變更，請重新登入。');
  await updateLocal<PageNode[]>(`tree:${owner.id}`, () => manifest.tree);
  const known = await offlineNotes();
  const active = new Set(manifest.pages.map(item => item.page.id));
  for (const note of known) {
    if (user?.id !== owner.id) return;
    if (note.local.page.kind === 'page' && !active.has(note.local.page.id) && !note.isNew) {
      await markRemoved(owner, note);
    }
  }
  for (const summary of manifest.pages) {
    if (user?.id !== owner.id) return;
    const current = await offlineNote(summary.page.id);
    if (current?.pending) {
      // The draft keeps its baseline, but what the reader may do with a shared page is the server's to say.
      if (JSON.stringify(current.base.access) !== JSON.stringify(summary.access)) await updateLocal<OfflineNote>(pageKey(owner.id, summary.page.id), note => note && { ...note, base: withAccess(note.base, summary.access), local: withAccess(note.local, summary.access) });
      continue;
    }
    if (current && !current.removed && JSON.stringify(summarizePage(current.base)) === JSON.stringify(summary)) continue;
    const response = await api<PageResponse>('GET', `/api/pages/${summary.page.id}`);
    if (response.page.trashedAt !== null) throw new ApiError(404, 'not_found', '筆記清單已變更，請重新同步。');
    await cachePage(response, owner.id);
    if (offlineStorageError) throw new Error(offlineStorageError);
  }
  await pullDatabases(owner, manifest, known);
  await pullAnnotations(owner, manifest);
  if (user?.id === owner.id) {
    await updateLocal<IncomingShareDto[]>(sharedKey(owner.id), () => manifest.shared ?? []).catch(() => undefined);
    await updateLocal<number>(`upload-limit:${owner.id}`, () => manifest.maxUploadBytes).catch(() => undefined);
    setSyncStatus({ ...syncStatus, maxUploadBytes: manifest.maxUploadBytes });
    window.dispatchEvent(new Event(SYNC_TREE_EVENT));
  }
}

function withAccess(response: PageResponse, access: PageResponse['access']): PageResponse {
  const { access: _previous, ...rest } = response;
  return access ? { ...rest, access } : rest;
}

/**
 * What I share and what is shared with me. Without a connection the list of what is shared with me comes from this
 * device, so those notes stay reachable from the sidebar; managing my own shares needs the server.
 */
export async function loadShares(): Promise<SharesDto> {
  const owner = user;
  try {
    const shares = await api<SharesDto>('GET', '/api/shares');
    if (owner && user?.id === owner.id) await updateLocal<IncomingShareDto[]>(sharedKey(owner.id), () => shares.incoming).catch(storageError);
    return shares;
  } catch (error) {
    if (!transient(error) || !owner) throw error;
    return { outgoing: [], incoming: await readLocal<IncomingShareDto[]>(sharedKey(owner.id)) ?? [] };
  }
}

/** A clean copy of something deleted online: keep a marker for an open editor, but not its text. */
async function markRemoved(owner: UserDto, note: OfflineNote): Promise<void> {
  await updateLocal<OfflineNote>(pageKey(owner.id, note.local.page.id), current => {
    if (!current || user?.id !== owner.id || current.revision !== note.revision || current.pending) return current;
    const emptied = (response: PageResponse): PageResponse => ({ ...response, page: { ...response.page, content: [] } });
    return { ...current, removed: true, base: emptied(current.base), local: emptied(current.local) };
  });
}

const ROW_PAGE_BATCH = 50;
/**
 * Databases are downloaded whole (structure, views, every row) whenever their stamp changed, followed by the row
 * pages whose summary differs from the copy kept here. The stamp is stored last, so an interrupted download repeats.
 */
async function pullDatabases(owner: UserDto, manifest: OfflineManifest, known: OfflineNote[]): Promise<void> {
  const listed = new Set((manifest.databases ?? []).map(item => item.id));
  for (const { id, stamp } of manifest.databases ?? []) {
    if (user?.id !== owner.id) return;
    if ((await storedDatabase(owner.id, id))?.stamp === stamp) continue;
    const snapshot = await api<DatabaseSnapshotDto>('GET', `/api/offline/databases/${id}`);
    const changed: string[] = [];
    for (const summary of snapshot.pages) {
      const current = await offlineNote(summary.page.id);
      if (current?.pending) continue;
      if (!current || current.removed || JSON.stringify(summarizePage(current.base)) !== JSON.stringify(summary)) changed.push(summary.page.id);
    }
    for (let index = 0; index < changed.length; index += ROW_PAGE_BATCH) {
      if (user?.id !== owner.id) return;
      const batch = await api<{ pages: PageResponse[] }>('GET', `/api/offline/pages?ids=${changed.slice(index, index + ROW_PAGE_BATCH).join(',')}`);
      for (const page of batch.pages) await cachePage(page, owner.id);
    }
    const database = await offlineNote(id);
    if (!database || database.removed || JSON.stringify(summarizePage(database.base)) !== JSON.stringify(summarizePage(snapshot.page))) await cachePage(snapshot.page, owner.id);
    if (offlineStorageError) throw new Error(offlineStorageError);
    const alive = new Set(snapshot.pages.map(summary => summary.page.id));
    // The server lists a row that is still marked as existing only here (its "create" was confirmed from another tab).
    for (const note of known) if (note.localOnly && alive.has(note.local.page.id)) await updateLocal<OfflineNote>(pageKey(owner.id, note.local.page.id), current => current?.localOnly ? { ...current, localOnly: undefined } : current);
    for (const note of known) if (note.local.page.kind === 'row' && note.local.page.databaseId === id && !alive.has(note.local.page.id) && !note.localOnly) await markRemoved(owner, note);
    if (user?.id !== owner.id) return;
    await storeDatabase(owner.id, snapshot);
  }
  // A database deleted online: its copy goes, and so do the clean copies of its page and rows.
  for (const stored of await storedDatabases(owner.id)) {
    if (user?.id !== owner.id) return;
    if (listed.has(stored.meta.id)) continue;
    await forgetDatabase(owner.id, stored.meta.id);
    for (const note of known) if (note.local.page.id === stored.meta.id || (note.local.page.kind === 'row' && note.local.page.databaseId === stored.meta.id && !note.localOnly)) await markRemoved(owner, note);
  }
}

/** Discussions are downloaded per page, only where the page's stamp changed. */
async function pullAnnotations(owner: UserDto, manifest: OfflineManifest): Promise<void> {
  const stamps = new Map((manifest.annotations ?? []).map(item => [item.pageId, item.stamp]));
  for (const [pageId, stamp] of stamps) {
    if (user?.id !== owner.id) return;
    if (await storedAnnotationStamp(owner.id, pageId) === stamp) continue;
    const list = await api<{ annotations: Annotation[] }>('GET', `/api/pages/${pageId}/annotations`);
    if (user?.id !== owner.id) return;
    await storeAnnotations(owner.id, pageId, stamp, list.annotations);
  }
  for (const stored of await storedAnnotations(owner.id)) if (!stamps.has(stored.pageId) && user?.id === owner.id) await forgetAnnotations(owner.id, stored.pageId);
}

export function syncNotes({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (force) { nextDownloadAt = 0; retryAt = 0; }
  if (syncing) return syncing;
  syncing = (async () => {
    const owner = user;
    if (!owner || navigator.onLine === false || Date.now() < retryAt) return;
    const pending = (await offlineNotes()).some(note => note.pending && !note.problem && !note.localOnly)
      || (await queuedOps(owner.id)).some(item => !item.problem) || (await pendingUploads(owner.id)).some(item => !item.problem);
    if (!pending && Date.now() < nextDownloadAt) return;
    setSyncStatus({ ...syncStatus, phase: 'syncing', error: undefined });
    try {
      // Never replay one account's local queue under another account's cookies. CSRF is freshly fetched, not persisted.
      const session = await api<SessionDto>('GET', '/api/auth/me');
      if (user?.id !== owner.id) return;
      if (session.user.id !== owner.id) throw new ApiError(401, 'unauthorized', '登入帳號已變更，請重新登入。');
      setCsrfToken(session.csrfToken);
      // Files first, so no other device ever sees a note that refers to a file the server does not have. Then the
      // changes to databases (a new row must exist before its page is synced), the notes, and once more the queue:
      // a discussion on a page created offline can only be sent after that page.
      await sendUploads(owner.id);
      // Whatever is still waiting was refused by the server; the notes that show it stay here until that is settled.
      const waitingFiles = (await pendingUploads(owner.id)).map(item => item.url);
      await sendOps(owner.id);
      for (const note of await offlineNotes()) {
        if (user?.id !== owner.id) break;
        await sendNote(owner, note.local.page.id, waitingFiles);
      }
      if (user?.id !== owner.id) return;
      await sendOps(owner.id);
      if (user?.id !== owner.id) return;
      let downloaded = false;
      if (Date.now() >= nextDownloadAt) {
        await pullNotes(owner);
        downloaded = true;
        nextDownloadAt = Date.now() + 60_000;
      }
      if (user?.id !== owner.id) return;
      if (offlineStorageError) throw new Error(offlineStorageError);
      failures = 0; retryAt = 0;
      const remaining = (await unsyncedWork()).total > 0;
      const completedAt = downloaded && !remaining ? Date.now() : syncStatus.completedAt;
      if (downloaded && !remaining && !syncStatus.completedAt && navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
      if (downloaded && !remaining) await updateLocal<number>(`synced:${owner.id}`, () => completedAt!);
      if (user?.id === owner.id) setSyncStatus({ ...syncStatus, phase: remaining ? 'pending' : completedAt ? 'complete' : 'idle', completedAt, error: undefined });
    } catch (error) {
      if (user?.id !== owner.id) return;
      const retrySeconds = isApiError(error) ? Number(error.details?.retryAfterSeconds) || 0 : 0;
      retryAt = Date.now() + Math.max(Math.min(15_000 * 2 ** failures++, 300_000), retrySeconds * 1000);
      setSyncStatus({ ...syncStatus, phase: 'error', error: error instanceof Error ? error.message : '同步尚未完成，稍後自動重試。' });
    }
  })().finally(() => { syncing = undefined; });
  return syncing;
}

export async function resolveLocalNote(id: string, choice: 'reload' | 'overwrite', content?: unknown[]): Promise<LocalPageResponse> {
  const owner = user;
  if (!owner) throw new Error('請先登入。');
  const original = await offlineNote(id);
  const fresh = await api<PageResponse>('GET', `/api/pages/${id}`);
  if (user?.id !== owner.id) throw new Error('帳號已切換，請重新開啟筆記。');
  const note = await updateLocal<OfflineNote>(pageKey(owner.id, id), current => {
    if (user?.id !== owner.id) throw new Error('帳號已切換，請重新開啟筆記。');
    if (!current) throw new Error('找不到本機草稿。');
    if (current.revision !== original?.revision) throw new ApiError(409, 'version_conflict', '處理衝突期間，另一個分頁已更新草稿，請重新檢查。');
    if (fresh.page.trashedAt !== null) throw new ApiError(404, 'not_found', '此筆記已在線上刪除，請先匯出本機草稿。');
    if (choice === 'reload') return { ...current, base: fresh, local: fresh, revision: crypto.randomUUID(), writer, pending: false, isNew: false, sending: undefined, problem: undefined, conflict: undefined, removed: undefined };
    const revision = crypto.randomUUID();
    const draft = content ?? current.local.page.content;
    return { ...current, base: fresh, local: { ...fresh, page: { ...fresh.page, title: current.local.page.title, content: draft } }, revision, writer, pending: true, isNew: false, problem: undefined, conflict: undefined, removed: undefined,
      sending: { revision, input: { operationId: crypto.randomUUID(), baseVersion: fresh.page.version, baseTitle: fresh.page.title, parentId: fresh.page.parentId, title: current.local.page.title, content: draft, overwrite: true } } };
  });
  void syncNotes();
  return localResponse(note!);
}

export async function downloadNotes(): Promise<void> {
  await syncNotes({ force: true });
  if (syncStatus.phase === 'error') throw new Error(syncStatus.error);
  if (navigator.storage?.persist) await navigator.storage.persist();
}
