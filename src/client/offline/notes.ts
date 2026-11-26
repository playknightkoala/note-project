import type { PageHeadDto, PageNode, PageResponse, SessionDto, TreeDto, UserDto } from '@shared/api';
import { newId } from '@shared/ids';
import { movedSince, summarizePage } from '@shared/offline';
import type { DatabaseSnapshotDto, OfflineManifest, SyncNoteInput, SyncNoteResult } from '@shared/offline';
import type { IncomingShareDto, SharesDto } from '@shared/shares';
import type { Annotation } from '@shared/annotations';
import { AUTH_LOST_EVENT, ApiError, api, isApiError, setCsrfToken } from '../api/client.ts';
import { canReachServer, connectionState } from './connection.ts';
import { announceOfflineChange, listLocal, readLocal, removeLocal, updateLocal, updateLocalWith } from './storage.ts';
import { fileCache, pageKey, setOfflineOwner, sharedKey, uploadCache, uploadPrefix } from './owner.ts';
import { forgetAnnotations, forgetDatabase, mustStop, queuedOps, sendOps, storeAnnotations, storeDatabase, storedAnnotationStamp, storedAnnotations, storedDatabase, storedDatabases, transient } from './outbox.ts';
import { pendingUploads, sendUploads, sendableUploads } from './uploads.ts';
import type { PendingUpload } from './uploads.ts';

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
  /**
   * What is on its way to the server: an operation id together with the text it carries. Fixed once and never
   * changed or taken back, so that every repeat (by this tab, another one, or one still running an earlier version
   * of the interface) sends exactly the same operation, and the server's answer to it always means that text.
   */
  sending?: { input: SyncNoteInput; revision: string };
  problem?: string;
  conflict?: PageHeadDto;
  removed?: boolean;
  /** A row made on this device whose "create row" change has not reached the server yet; its page cannot be synced before that. */
  localOnly?: boolean;
}
/** Kinds whose text is written on this device first and synced afterwards. A database page has no text of its own. */
export const hasDraft = (kind: PageResponse['page']['kind']): boolean => kind !== 'database';
// `newId`, never `crypto.randomUUID`: on a plain-HTTP origin browsers do not have it, and this module is loaded before anything is shown.
const writer = newId();
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
export async function cachedUser(signal?: AbortSignal): Promise<UserDto | null> {
  try {
    const cached = await readLocal<UserDto>('user');
    if (signal?.aborted) return null;
    setUser(cached ?? null);
    if (user) await restoreSyncStatus(user.id);
    return user;
  } catch (error) { storageError(error); return null; }
}
/** A known 401 revokes offline entry. Keep unsynced drafts for the same account's next login. */
export async function revokeOfflineEntry(): Promise<void> {
  const owner = user?.id;
  setUser(null);
  setSyncStatus({ phase: 'idle', completedAt: null });
  setCsrfToken(null);
  await updateLocal<UserDto>('user', current => owner && current?.id !== owner ? current : undefined).catch(storageError);
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
  const owner = user?.id;
  const note = owner ? await readLocal<OfflineNote>(pageKey(owner, id)) : undefined;
  return user?.id === owner && note?.userId === owner ? note : undefined;
}
const localResponse = (note: OfflineNote): LocalPageResponse => ({ ...note.local, localRevision: note.revision });
const readable = (note: OfflineNote) => !note.removed || (note.pending && !note.local.access);

export async function cachePage(response: PageResponse, expectedUserId = user?.id): Promise<LocalPageResponse> {
  const owner = user;
  if (owner?.id !== expectedUserId) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟筆記。');
  if (!owner) return response;
  try {
    const note = await updateLocal<OfflineNote>(pageKey(owner.id, response.page.id), current => {
      if (user?.id !== owner.id) throw new ApiError(401, 'unauthorized', '帳號已切換。');
      if (current?.pending) return { ...current, removed: false, base: withAccess(current.base, response.access), local: withAccess(current.local, response.access) };
      if (current && current.base.page.version > response.page.version) return current;
      // Icon, cover, favourite, position and ancestor names change without a new content version. Those must not
      // look like someone else's edit to an open editor, so the revision only changes with the text itself.
      // A row's name is one of its database cells, not part of the text that is drafted here.
      const sameText = !!current && !current.removed && current.base.page.version === response.page.version && (response.page.kind === 'row' || current.base.page.title === response.page.title)
        && JSON.stringify(current.base.page.content) === JSON.stringify(response.page.content);
      return { userId: owner.id, base: response, local: response, revision: sameText ? current.revision : newId(), writer: sameText ? current.writer : '', isNew: false, pending: false };
    });
    return localResponse(note!);
  } catch (error) { if (isApiError(error, 401)) throw error; storageError(error); return response; }
}

interface Preview<T> { signal: AbortSignal; publish: (copy: T) => void }

export async function loadNote(id: string, preview?: Preview<LocalPageResponse>): Promise<LocalPageResponse> {
  const owner = user?.id;
  const local = await offlineNote(id).catch(() => undefined);
  const available = local && readable(local);
  if (available && (local.isNew || local.localOnly)) return localResponse(local);
  if (available && !local.local.access) preview?.publish(localResponse(local));
  try {
    const response = await api<PageResponse>('GET', `/api/pages/${id}`, preview ? { signal: preview.signal } : {});
    if (preview?.signal.aborted) throw preview.signal.reason;
    return await cachePage(response, owner);
  }
  catch (error) {
    if (owner && user?.id === owner && local && (isApiError(error, 403) || isApiError(error, 404))) await markRemoved(owner, local);
    if (!transient(error)) throw error;
    if (user?.id !== owner) throw error;
    const cached = await offlineNote(id);
    if (cached && !readable(cached)) throw new ApiError(404, 'not_found', '這個頁面已刪除或停止分享。');
    if (cached?.local.access && (connectionState() === 'unstable' || isApiError(error) && error.details?.timeout === true)) {
      throw new ApiError(0, 'internal', '連線穩定後可重新確認共用頁面的存取權限。');
    }
    if (cached) return localResponse(cached);
    throw new ApiError(0, 'internal', '此筆記尚未下載至此裝置，連線後開啟一次即可離線使用。');
  }
}

function nodeOf(note: OfflineNote): PageNode {
  const p = note.local.page;
  return { id: p.id, parentId: p.parentId, kind: p.kind, title: p.title, icon: p.icon, position: p.createdAt, isFavorite: p.isFavorite, favoritePosition: null, hasChildren: false, updatedAt: p.updatedAt };
}
export async function loadTree(preview?: Preview<PageNode[]>): Promise<PageNode[]> {
  const owner = user;
  const local = owner ? readLocal<PageNode[]>(`tree:${owner.id}`).catch(() => undefined) : Promise.resolve(undefined);
  if (preview) void local.then(async nodes => {
    if (nodes === undefined || user?.id !== owner?.id || preview.signal.aborted) return;
    const tree = await treeWithDrafts(nodes);
    if (user?.id === owner?.id && !preview.signal.aborted) preview.publish(tree);
  });
  let nodes: PageNode[];
  try {
    nodes = (await api<TreeDto>('GET', '/api/pages/tree', preview ? { signal: preview.signal } : {})).pages;
    if (preview?.signal.aborted) throw preview.signal.reason;
    if (user?.id !== owner?.id) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟筆記。');
    if (owner) await updateLocal<PageNode[]>(`tree:${owner.id}`, () => nodes).catch(storageError);
  } catch (error) {
    if (!transient(error) || user?.id !== owner?.id) throw error;
    nodes = await local ?? [];
  }
  const tree = await treeWithDrafts(nodes);
  if (user?.id !== owner?.id) throw new ApiError(401, 'unauthorized', '帳號已切換，請重新開啟筆記。');
  return tree;
}

async function treeWithDrafts(nodes: PageNode[]): Promise<PageNode[]> {
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
  const id = newId(), at = Date.now();
  const parent = input.parentId ? await offlineNote(input.parentId) : undefined;
  if (input.parentId && (!parent || parent.local.page.kind !== 'page')) throw new Error('請先連線下載上層筆記。');
  // The server would refuse it, and the note would wait on this device for ever.
  if (parent?.local.access) throw new Error('只有擁有者可以在共用的頁面底下新增子頁面。');
  const response: PageResponse = {
    page: { id, parentId: input.parentId ?? null, kind: 'page', databaseId: null, title: input.title ?? '', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 0, isFavorite: false, trashedAt: null, createdAt: at, updatedAt: at },
    breadcrumbs: [...(parent?.local.breadcrumbs ?? []), { id, title: input.title ?? '', icon: null, kind: 'page' }],
  };
  const note: OfflineNote = { userId: user.id, base: response, local: response, revision: newId(), writer, isNew: true, pending: true };
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
  await updateLocal<OfflineNote>(pageKey(owner.id, rowId), current => current ?? { userId: owner.id, base: response, local: response, revision: newId(), writer: '', isNew: false, pending: false, localOnly: true });
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
    return { ...current, local: { ...current.local, page: { ...current.local.page, ...change, updatedAt: Date.now() } }, revision: newId(), writer, pending: true };
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

/** Whether the text shows one of these attachments, which are still on this device only (waiting, or refused by the server). */
function showsFile(content: unknown, waiting: PendingUpload[]): boolean {
  if (!waiting.length) return false;
  const text = JSON.stringify(content);
  return waiting.some(item => text.includes(item.url));
}

/**
 * A note that shows an attachment the server does not have yet is not sent before it. Whether it does is decided
 * in the same step of the device store that fixes what is sent: a file is listed there as waiting before its
 * address is given to the editor, so a text that shows it always finds it listed, whichever tab added it and
 * however far the sync had got. Nothing that was fixed is ever taken back, so another tab that reads it may send it
 * as well (the server carries out an operation once).
 */
async function sendNote(owner: UserDto, id: string): Promise<void> {
  const key = pageKey(owner.id, id);
  let note = await readLocal<OfflineNote>(key);
  if (!note?.pending || note.problem || note.localOnly || user?.id !== owner.id) return;
  // A first look, to leave a note that has to wait untouched; the decision is made below.
  const waitingNow = await pendingUploads(owner.id);
  if (showsFile(note.local.page.content, waitingNow) && (!note.sending || showsFile(note.sending.input.content, waitingNow))) return;
  if (user?.id !== owner.id) return;
  if (note.isNew && note.local.page.parentId) {
    const parent = await readLocal<OfflineNote>(pageKey(owner.id, note.local.page.parentId));
    if (parent?.isNew) {
      await sendNote(owner, parent.local.page.id);
      if ((await readLocal<OfflineNote>(pageKey(owner.id, parent.local.page.id)))?.isNew) return;
    }
  }
  const decided = { go: false };
  note = await updateLocalWith<OfflineNote, PendingUpload>(key, uploadPrefix(owner.id), (current, waiting) => {
    decided.go = false;
    if (!current?.pending || current.problem || current.localOnly) return current;
    if (current.sending) {
      // Fixed before (a repeat, or the user's explicit overwrite): it goes exactly as it was.
      if (!showsFile(current.sending.input.content, waiting)) { decided.go = true; return current; }
      // It shows a file that still waits. While the draft shows one too, nothing could be sent anyway: it waits.
      // Once the draft no longer does (the file was taken out of the text), sending the old text is wrong, and so
      // is changing or dropping an operation that may have reached the server or may be sent by another tab. The
      // user decides, as with any conflict; "overwrite" then fixes a new operation from the draft and the page as
      // it is on the server by then.
      if (showsFile(current.local.page.content, waiting)) return current;
      return { ...current, problem: '先前準備送出的內容含有尚未上傳的附件，而這裡的內容已經不同。請選擇以這裡的內容覆蓋，或載入線上版本。',
        conflict: { version: current.base.page.version, title: current.base.page.title, updatedAt: current.base.page.updatedAt } };
    }
    if (showsFile(current.local.page.content, waiting)) return current;
    decided.go = true;
    return { ...current, sending: { revision: current.revision, input: {
      operationId: newId(), baseVersion: current.isNew ? null : current.base.page.version, baseTitle: current.base.page.title,
      title: current.local.page.title, content: current.local.page.content, parentId: current.local.page.parentId, overwrite: false, repeatAware: true,
    } } };
  });
  const sent = note?.sending;
  // Never send one account's draft under another account's session.
  if (!decided.go || !sent || user?.id !== owner.id) return;
  try {
    const { applied, ...response } = await api<PageResponse & { applied?: SyncNoteResult['applied'] }>('PUT', `/api/offline/pages/${id}`, { json: sent.input, headers: { 'if-match': `"${sent.input.baseVersion ?? 0}"` } });
    // The answer to a repeat (the first answer was lost) shows the page as it is now. When somebody else has saved
    // since this operation, that page is not what the text on this device was written on.
    const moved = movedSince({ ...response, ...(applied ? { applied } : {}) });
    await updateLocal<OfflineNote>(key, current => {
      if (!current || current.sending?.input.operationId !== sent.input.operationId) return current;
      const pending = current.revision !== sent.revision;
      // Written on since: a conflict for the user to settle, exactly as if the server had refused it. Never a new baseline.
      if (pending && moved) return { ...current, isNew: false, sending: undefined, problem: '此頁面已在其他地方更新。', conflict: { version: response.page.version, title: response.page.title, updatedAt: response.page.updatedAt } };
      // Nothing written since: the newer page replaces the copy here, and an open editor is told to load it
      // (a new revision that is not this tab's own), so it cannot go on typing over a text it no longer shows.
      if (moved) return { ...current, base: response, local: response, revision: newId(), writer: '', pending: false, isNew: false, sending: undefined, problem: undefined, conflict: undefined };
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
      await markRemoved(owner.id, note);
    }
  }
  for (const summary of manifest.pages) {
    if (user?.id !== owner.id) return;
    const current = await offlineNote(summary.page.id);
    if (current?.pending) {
      // The draft keeps its baseline, but what the reader may do with a shared page is the server's to say.
      if (current.removed || JSON.stringify(current.base.access) !== JSON.stringify(summary.access)) await updateLocal<OfflineNote>(pageKey(owner.id, summary.page.id), note => note && { ...note, removed: false, base: withAccess(note.base, summary.access), local: withAccess(note.local, summary.access) });
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
    if (!transient(error) || !owner || user?.id !== owner.id) throw error;
    const incoming = await readLocal<IncomingShareDto[]>(sharedKey(owner.id));
    if (user?.id !== owner.id) throw error;
    return { outgoing: [], incoming: incoming ?? [] };
  }
}

/** Keep a marker for the editor after a deletion or revocation, and preserve drafts for export. */
async function markRemoved(owner: string, note: OfflineNote): Promise<void> {
  await updateLocal<OfflineNote>(pageKey(owner, note.local.page.id), current => {
    if (!current || user?.id !== owner || (!current.local.access && current.revision !== note.revision)) return current;
    if (current.pending) return current.local.access ? { ...current, removed: true } : current;
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
      if (current?.pending) {
        // As for notes: the draft keeps its baseline, but what the reader may do with the row is the server's to say.
        if (current.removed || JSON.stringify(current.base.access) !== JSON.stringify(summary.access)) await updateLocal<OfflineNote>(pageKey(owner.id, summary.page.id), note => note && { ...note, removed: false, base: withAccess(note.base, summary.access), local: withAccess(note.local, summary.access) });
        continue;
      }
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
    for (const note of known) if (note.local.page.kind === 'row' && note.local.page.databaseId === id && !alive.has(note.local.page.id) && !note.localOnly) await markRemoved(owner.id, note);
    if (user?.id !== owner.id) return;
    await storeDatabase(owner.id, snapshot);
  }
  // A database deleted online: its copy goes, and so do the clean copies of its page and rows.
  for (const stored of await storedDatabases(owner.id)) {
    if (user?.id !== owner.id) return;
    if (listed.has(stored.meta.id)) continue;
    await forgetDatabase(owner.id, stored.meta.id);
    for (const note of known) if (note.local.page.id === stored.meta.id || (note.local.page.kind === 'row' && note.local.page.databaseId === stored.meta.id && !note.localOnly)) await markRemoved(owner.id, note);
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

/** The offline profile identifies a queue. Only a fresh server session can authorize sending it. */
export async function verifySyncSession(): Promise<boolean> {
  const owner = user?.id;
  if (!owner) return false;
  const session = await api<SessionDto>('GET', '/api/auth/me', { cache: 'no-store' });
  if (user?.id !== owner) return false;
  if (session.user.id !== owner) {
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    return false;
  }
  setCsrfToken(session.csrfToken);
  return true;
}

export function syncNotes({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (force) { nextDownloadAt = 0; retryAt = 0; }
  if (syncing) return syncing;
  syncing = (async () => {
    const owner = user;
    if (!owner || !canReachServer() || Date.now() < retryAt) return;
    const pending = (await offlineNotes()).some(note => note.pending && !note.problem && !note.localOnly)
      || (await queuedOps(owner.id)).some(item => !item.problem) || (await sendableUploads(owner.id)).length > 0;
    if (!pending && Date.now() < nextDownloadAt) return;
    setSyncStatus({ ...syncStatus, phase: 'syncing', error: undefined });
    try {
      // Never replay one account's local queue under another account's cookies. CSRF is freshly fetched, not persisted.
      if (!await verifySyncSession() || user?.id !== owner.id || !canReachServer()) return;
      // The changes to databases first: a row added here must exist on the server before its page is synced, and
      // before a file added to it in somebody else's database is accepted (the server checks the row; while the row
      // is still waiting, so is the file). Then the files, before any note, so no other device ever sees a note that
      // refers to a file the server does not have. Then the notes, and once more the queue: a discussion on a page
      // created offline can only be sent after it.
      await sendOps(owner.id);
      await sendUploads(owner.id);
      // Whatever is still waiting was refused by the server, waits for its row, or was added since: the notes
      // that show it stay here until it has been uploaded.
      for (const note of await offlineNotes()) {
        if (user?.id !== owner.id) break;
        await sendNote(owner, note.local.page.id);
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
    if (choice === 'reload') return { ...current, base: fresh, local: fresh, revision: newId(), writer, pending: false, isNew: false, sending: undefined, problem: undefined, conflict: undefined, removed: undefined };
    const revision = newId();
    const draft = content ?? current.local.page.content;
    // The overwrite is fixed here and now, with the version it overwrites; the sync holds it back while it shows
    // a file that is not on the server yet.
    return { ...current, base: fresh, local: { ...fresh, page: { ...fresh.page, title: current.local.page.title, content: draft } }, revision, writer, pending: true, isNew: false, problem: undefined, conflict: undefined, removed: undefined,
      sending: { revision, input: { operationId: newId(), baseVersion: fresh.page.version, baseTitle: fresh.page.title, parentId: fresh.page.parentId, title: current.local.page.title, content: draft, overwrite: true, repeatAware: true } } };
  });
  void syncNotes();
  return localResponse(note!);
}

/**
 * The server replaced the page's text at this device's own request (a history restore). Its version becomes the
 * copy kept here, unless a draft is waiting on this device (written in another tab meanwhile): that one is never
 * thrown away, and meets the newer version as a conflict when it is synced. The check and the replacement are one
 * step in the device store. An open editor is told through the store, as for any text that arrives from elsewhere:
 * it loads the new text, or reports a conflict when it holds changes of its own.
 * 'absent': this device keeps no copy of the page.
 */
export async function adoptServerVersion(id: string): Promise<'adopted' | 'kept' | 'absent'> {
  const owner = user;
  if (!owner || !await offlineNote(id).catch(() => undefined)) return 'absent';
  const fresh = await api<PageResponse>('GET', `/api/pages/${id}`);
  let outcome: 'adopted' | 'kept' | 'absent' = 'absent';
  await updateLocal<OfflineNote>(pageKey(owner.id, id), current => {
    if (!current || user?.id !== owner.id) return current;
    if (current.pending || fresh.page.trashedAt !== null) { outcome = 'kept'; return current; }
    outcome = 'adopted';
    // Already brought in by a sync that ran in between, or something newer than what was fetched here: nothing
    // to replace, no reason to disturb the editor, and the copy on this device never goes back to an older version.
    if (current.base.page.version >= fresh.page.version) return current;
    return { ...current, base: fresh, local: fresh, revision: newId(), writer: '', pending: false, isNew: false, sending: undefined, problem: undefined, conflict: undefined, removed: undefined };
  });
  return outcome;
}

export async function downloadNotes(): Promise<void> {
  await syncNotes({ force: true });
  if (syncStatus.phase === 'error') throw new Error(syncStatus.error);
  if (navigator.storage?.persist) await navigator.storage.persist();
}
