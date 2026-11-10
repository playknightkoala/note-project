import type { PageHeadDto, PageNode, PageResponse, SessionDto, TreeDto, UserDto } from '@shared/api';
import { summarizePage } from '@shared/offline';
import type { OfflineManifest, SyncNoteInput } from '@shared/offline';
import { ApiError, api, isApiError, setCsrfToken } from '../api/client.ts';
import { announceOfflineChange, listLocal, readLocal, removeLocal, updateLocal } from './storage.ts';

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
}
const writer = crypto.randomUUID();
let user: UserDto | null = null;
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
  if (user?.id === owner) setSyncStatus({ phase: 'idle', completedAt: completedAt ?? null });
}
export let offlineStorageError: string | null = null;
const pageKey = (userId: string, id: string) => `page:${userId}:${id}`;
export const transient = (error: unknown) => isApiError(error) && (error.status === 0 || error.status >= 500);
const head = (note: OfflineNote): LocalHead => ({ version: note.base.page.version, title: note.local.page.title, updatedAt: note.local.page.updatedAt, localRevision: note.revision, queued: note.pending });
function storageError(error: unknown): void {
  const message = error instanceof Error ? error.message : '本機儲存無法使用。';
  if (offlineStorageError !== message) { offlineStorageError = message; announceOfflineChange(); }
}

/** Records are keyed `<kind>:<userId>[:<id>]`; the `user` record has no owner. */
const ownerOfKey = (key: string): string | undefined => /^(page|tree|synced|attachments|annotation-highlights):/.test(key) ? key.split(':')[1] : undefined;
const isUnsyncedDraft = (key: string, value: unknown): boolean => key.startsWith('page:') && (value as OfflineNote | undefined)?.pending === true;

/**
 * Removes other accounts' downloaded copies and attachment caches from this browser. Their unsynced drafts are the
 * only thing kept, so the owner can still upload or export them after signing in again.
 */
async function purgeOtherAccounts(keep: string): Promise<void> {
  await removeLocal((key, value) => { const owner = ownerOfKey(key); return owner !== undefined && owner !== keep && !isUnsyncedDraft(key, value); });
  if ('caches' in window) for (const name of await caches.keys()) if (name.startsWith('notes-files-') && name !== `notes-files-${keep}`) await caches.delete(name);
}

export async function rememberUser(value: UserDto): Promise<void> {
  const changed = user?.id !== value.id;
  user = value;
  try { await updateLocal<UserDto>('user', () => value); offlineStorageError = null; } catch (error) { storageError(error); }
  if (changed) { await purgeOtherAccounts(value.id).catch(storageError); await restoreSyncStatus(value.id); }
}
export async function cachedUser(): Promise<UserDto | null> {
  try { user = await readLocal<UserDto>('user') ?? null; if (user) await restoreSyncStatus(user.id); return user; } catch (error) { storageError(error); return null; }
}
/** A known 401 revokes offline entry. Keep unsynced drafts for the same account's next login. */
export async function revokeOfflineEntry(): Promise<void> {
  user = null;
  setSyncStatus({ phase: 'idle', completedAt: null });
  setCsrfToken(null);
  await updateLocal('user', () => undefined).catch(storageError);
}
/** Another tab ended or replaced the session: stop acting for the old account here, without touching storage. */
export function detachOfflineUser(): void {
  user = null;
  nextDownloadAt = 0; retryAt = 0; failures = 0;
  setSyncStatus({ phase: 'idle', completedAt: null });
}
/**
 * Sign-out: forget this account and every clean copy on the device. Unsynced drafts that belong to a different
 * account (whose session expired here earlier) are never deleted by someone else's sign-out.
 */
export async function forgetOfflineData(): Promise<void> {
  const owner = user?.id ?? (await readLocal<UserDto>('user').catch(() => undefined))?.id;
  user = null;
  nextDownloadAt = 0; retryAt = 0; failures = 0;
  setSyncStatus({ phase: 'idle', completedAt: null });
  await removeLocal((key, value) => ownerOfKey(key) === owner || !isUnsyncedDraft(key, value));
  if ('caches' in window) for (const name of await caches.keys()) if (name.startsWith('notes-files-')) await caches.delete(name);
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
      const sameText = !!current && !current.removed && current.base.page.version === response.page.version && current.base.page.title === response.page.title
        && JSON.stringify(current.base.page.content) === JSON.stringify(response.page.content);
      return { userId: owner.id, base: response, local: response, revision: sameText ? current.revision : crypto.randomUUID(), writer: sameText ? current.writer : '', isNew: false, pending: false };
    });
    return localResponse(note!);
  } catch (error) { if (isApiError(error, 401)) throw error; storageError(error); return response; }
}

export async function loadNote(id: string): Promise<LocalPageResponse> {
  const owner = user?.id;
  const local = await offlineNote(id).catch(() => undefined);
  if (local?.isNew && user?.id === owner) return localResponse(local);
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
  const pending = (await offlineNotes()).filter(n => n.pending);
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

/** Persist before networking. Revision checks prevent a stale tab from replacing another tab's local draft. */
async function editNote(id: string, change: { content?: unknown[]; title?: string }, expectedRevision?: string): Promise<OfflineNote> {
  if (!user) throw new Error('請先登入。');
  const note = await updateLocal<OfflineNote>(pageKey(user.id, id), current => {
    if (!current) throw new Error('此筆記尚未保存至本機，請先連線下載。');
    if (current.local.page.kind !== 'page') throw new Error('離線編輯目前只支援一般筆記。');
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

async function sendNote(owner: UserDto, id: string): Promise<void> {
  const key = pageKey(owner.id, id);
  let note = await readLocal<OfflineNote>(key);
  if (!note?.pending || note.problem || user?.id !== owner.id) return;
  if (note.isNew && note.local.page.parentId) {
    const parent = await readLocal<OfflineNote>(pageKey(owner.id, note.local.page.parentId));
    if (parent?.isNew) {
      await sendNote(owner, parent.local.page.id);
      if ((await readLocal<OfflineNote>(pageKey(owner.id, parent.local.page.id)))?.isNew) return;
    }
  }
  note = await updateLocal<OfflineNote>(key, current => {
    if (!current?.pending || current.problem || current.sending) return current;
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
    if (transient(error) || isApiError(error, 401)) throw error;
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
      await updateLocal<OfflineNote>(pageKey(owner.id, note.local.page.id), current => {
        if (!current || user?.id !== owner.id || current.revision !== note.revision || current.pending) return current;
        // Keep a marker for an editor that still has this page open, but not the text of a page deleted online.
        const emptied = (response: PageResponse): PageResponse => ({ ...response, page: { ...response.page, content: [] } });
        return { ...current, removed: true, base: emptied(current.base), local: emptied(current.local) };
      });
    }
  }
  for (const summary of manifest.pages) {
    if (user?.id !== owner.id) return;
    const current = await offlineNote(summary.page.id);
    if (current?.pending) continue;
    if (current && !current.removed && JSON.stringify(summarizePage(current.base)) === JSON.stringify(summary)) continue;
    const response = await api<PageResponse>('GET', `/api/pages/${summary.page.id}`);
    if (response.page.trashedAt !== null) throw new ApiError(404, 'not_found', '筆記清單已變更，請重新同步。');
    await cachePage(response, owner.id);
    if (offlineStorageError) throw new Error(offlineStorageError);
  }
  if (user?.id === owner.id) {
    setSyncStatus({ ...syncStatus, maxUploadBytes: manifest.maxUploadBytes });
    window.dispatchEvent(new Event(SYNC_TREE_EVENT));
  }
}

export function syncNotes({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (force) { nextDownloadAt = 0; retryAt = 0; }
  if (syncing) return syncing;
  syncing = (async () => {
    const owner = user;
    if (!owner || navigator.onLine === false || Date.now() < retryAt) return;
    const pending = (await offlineNotes()).some(note => note.pending && !note.problem);
    if (!pending && Date.now() < nextDownloadAt) return;
    setSyncStatus({ ...syncStatus, phase: 'syncing', error: undefined });
    try {
      // Never replay one account's local queue under another account's cookies. CSRF is freshly fetched, not persisted.
      const session = await api<SessionDto>('GET', '/api/auth/me');
      if (user?.id !== owner.id) return;
      if (session.user.id !== owner.id) throw new ApiError(401, 'unauthorized', '登入帳號已變更，請重新登入。');
      setCsrfToken(session.csrfToken);
      for (const note of await offlineNotes()) {
        if (user?.id !== owner.id) break;
        await sendNote(owner, note.local.page.id);
      }
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
      const remaining = (await offlineNotes()).some(note => note.pending);
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
