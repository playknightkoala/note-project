import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { PageHeadDto } from '@shared/api';
import { fetchHead, saveContent } from '../../api/pages.ts';
import { isApiError } from '../../api/client.ts';
import { isLocalWriter, offlineNote, resolveLocalNote, syncNotes } from '../../offline/notes.ts';
import type { LocalHead } from '../../offline/notes.ts';
import { OFFLINE_EVENT } from '../../offline/storage.ts';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error' | 'offline' | 'local';
export interface AutosaveState { status: SaveState; version: number; savedAt: number | null; error: string | null; conflictHead: PageHeadDto | null; attempts: number }
export type AutosaveAction =
  | { type: 'dirty' } | { type: 'saving' } | { type: 'saved'; version: number; at: number; stillDirty: boolean; queued?: boolean }
  | { type: 'conflict'; head: PageHeadDto } | { type: 'error'; message: string; offline: boolean }
  | { type: 'reset'; version: number } | { type: 'version'; version: number };

export function autosaveReducer(state: AutosaveState, action: AutosaveAction): AutosaveState {
  switch (action.type) {
    case 'dirty': return state.status === 'conflict' ? state : { ...state, status: state.status === 'saving' ? 'saving' : 'dirty' };
    case 'saving': return { ...state, status: 'saving' };
    case 'saved': return { ...state, status: action.stillDirty ? 'dirty' : action.queued ? 'local' : 'clean', version: action.version, savedAt: action.at, error: null, attempts: 0 };
    case 'conflict': return { ...state, status: 'conflict', conflictHead: action.head };
    case 'error': return { ...state, status: action.offline ? 'offline' : 'error', error: action.message, attempts: state.attempts + 1 };
    case 'reset': return { status: 'clean', version: action.version, savedAt: state.savedAt, error: null, conflictHead: null, attempts: 0 };
    case 'version': return { ...state, version: action.version };
  }
}

export const DEBOUNCE_MS = 800;
export const MAX_WAIT_MS = 5000;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const HEAD_POLL_MS = 30_000;

export interface AutosaveOptions {
  pageId: string;
  initialVersion: number;
  initialLocalRevision?: string;
  /** Serializes the editor; returns null while a composition is open (nothing is sent then). */
  getContent: () => unknown[] | null;
  /** The server has a newer version and nothing is dirty: replace the editor content. */
  onRemoteUpdate: () => void;
  now?: () => number;
}

/**
 * Debounced, version-aware autosave: one request in flight, re-save if edits arrived meanwhile, 409 → conflict
 * (the user chooses reload or overwrite), network errors retry with backoff, flush on hide/unload with keepalive.
 */
export function useAutosave({ pageId, initialVersion, initialLocalRevision, getContent, onRemoteUpdate, now = Date.now }: AutosaveOptions) {
  const [state, dispatch] = useReducer(autosaveReducer, { status: 'clean', version: initialVersion, savedAt: null, error: null, conflictHead: null, attempts: 0 });
  const ref = useRef({ dirty: false, inFlight: false, firstDirtyAt: 0, timer: null as ReturnType<typeof setTimeout> | null, retry: null as ReturnType<typeof setTimeout> | null, version: initialVersion, status: 'clean' as SaveState });
  const getContentRef = useRef(getContent); getContentRef.current = getContent;
  const localRevision = useRef(initialLocalRevision);
  const localConflict = useRef(false);
  const remoteRef = useRef(onRemoteUpdate); remoteRef.current = onRemoteUpdate;
  ref.current.status = state.status;

  const clearTimers = () => { const r = ref.current; if (r.timer) clearTimeout(r.timer); if (r.retry) clearTimeout(r.retry); r.timer = null; r.retry = null; };

  const save = useCallback(async (options: { keepalive?: boolean; overrideVersion?: number } = {}): Promise<void> => {
    const r = ref.current;
    if (r.inFlight || r.status === 'conflict') return;
    const content = getContentRef.current();
    if (!content) { schedule(); return; }
    r.inFlight = true; r.dirty = false; clearTimers();
    dispatch({ type: 'saving' });
    try {
      const head: LocalHead = await saveContent(pageId, options.overrideVersion ?? r.version, content, { ...(options.keepalive ? { keepalive: true } : {}), overwrite: options.overrideVersion !== undefined, localRevision: localRevision.current });
      r.inFlight = false;
      // The ref is the source of truth for the next If-Match: a follow-up save may start before React re-renders.
      r.version = head.version;
      localRevision.current = head.localRevision;
      dispatch({ type: 'saved', version: head.version, at: now(), stillDirty: r.dirty, queued: head.queued });
      if (r.dirty) schedule(0);
    } catch (error) {
      r.inFlight = false; r.dirty = true;
      if (isApiError(error, 409)) { localConflict.current = error.details?.localConflict === true; dispatch({ type: 'conflict', head: (error.details?.current as PageHeadDto) ?? { version: r.version, updatedAt: 0, title: '' } }); return; }
      if (isApiError(error, 401) || isApiError(error, 404)) { dispatch({ type: 'error', message: error.message, offline: false }); return; }
      const offline = isApiError(error, 0) || (isApiError(error) && error.status >= 500);
      dispatch({ type: 'error', message: error instanceof Error ? error.message : '儲存失敗', offline });
      const attempt = Math.min(stateAttempts.current, BACKOFF_MS.length - 1);
      r.retry = setTimeout(() => { void save(); }, BACKOFF_MS[attempt]);
    }
  }, [pageId]);
  const stateAttempts = useRef(0); stateAttempts.current = state.attempts;

  const schedule = useCallback((delay = DEBOUNCE_MS) => {
    const r = ref.current;
    if (r.status === 'conflict') return;
    if (!r.firstDirtyAt) r.firstDirtyAt = now();
    if (r.timer) clearTimeout(r.timer);
    const sinceFirst = now() - r.firstDirtyAt;
    const wait = Math.max(0, Math.min(delay, MAX_WAIT_MS - sinceFirst));
    r.timer = setTimeout(() => { r.timer = null; r.firstDirtyAt = 0; void save(); }, wait);
  }, [save]);

  /** Call on every editor change outside a composition. */
  const markDirty = useCallback(() => { ref.current.dirty = true; dispatch({ type: 'dirty' }); schedule(); }, [schedule]);

  const flush = useCallback((keepalive = false) => { if (ref.current.dirty && !ref.current.inFlight) void save({ keepalive }); }, [save]);

  const resolveConflict = useCallback(async (choice: 'reload' | 'overwrite') => {
    const r = ref.current;
    clearTimers();
    const local = await offlineNote(pageId).catch(() => undefined);
    if (local?.local.page.kind === 'page') {
      try {
        if (localConflict.current && choice === 'reload') {
          // Another tab's unsynced draft is the latest local version, not something to discard on the server.
          localConflict.current = false; r.dirty = false; r.status = 'clean';
          dispatch({ type: 'reset', version: r.version }); remoteRef.current(); return;
        }
        // Preserve the latest visible edits before an explicit overwrite, including edits made after a conflict.
        if (choice === 'overwrite') {
          const content = getContentRef.current();
          if (!content) return;
          await resolveLocalNote(pageId, choice, content);
        } else await resolveLocalNote(pageId, choice);
        r.dirty = false; r.status = 'clean';
        dispatch({ type: 'reset', version: r.version });
        remoteRef.current();
      } catch (error) { dispatch({ type: 'error', message: error instanceof Error ? error.message : '無法解決衝突', offline: false }); }
      return;
    }
    const head = state.conflictHead;
    if (choice === 'overwrite' && head) {
      dispatch({ type: 'reset', version: head.version });
      r.status = 'dirty'; r.dirty = true; r.version = head.version;
      await save({ overrideVersion: head.version });
    } else {
      // Keep the old If-Match until the new content has actually been applied.
      dispatch({ type: 'reset', version: r.version });
      r.dirty = false; r.status = 'clean';
      remoteRef.current();
    }
  }, [save, state.conflictHead]);

  useEffect(() => {
    let active = true;
    const refresh = () => { void offlineNote(pageId).then(note => {
      const r = ref.current;
      if (!active || !note || r.inFlight) return;
      if (note.removed && !note.pending) { dispatch({ type: 'error', message: '此筆記已在線上刪除；若有本機修改，請先保存或匯出草稿。', offline: false }); return; }
      if (note.problem) {
        if (note.conflict) { localConflict.current = false; dispatch({ type: 'conflict', head: note.conflict }); }
        else dispatch({ type: 'error', message: note.problem, offline: false });
        return;
      }
      if (note.revision !== localRevision.current && !isLocalWriter(note)) {
        if (r.dirty) { localConflict.current = note.pending; dispatch({ type: 'conflict', head: { version: note.base.page.version, title: note.local.page.title, updatedAt: note.local.page.updatedAt } }); }
        else remoteRef.current();
        return;
      }
      localRevision.current = note.revision;
      r.version = note.base.page.version;
      if (!r.dirty) dispatch({ type: 'saved', version: r.version, at: now(), stillDirty: false, queued: note.pending });
    }).catch(() => {}); };
    window.addEventListener(OFFLINE_EVENT, refresh);
    refresh();
    return () => { active = false; window.removeEventListener(OFFLINE_EVENT, refresh); };
  }, [pageId]);

  // Flush when the tab hides or the page unloads; a dirty editor on route change is flushed by the unmount cleanup.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush(true); };
    const onUnload = (event: BeforeUnloadEvent) => { if (ref.current.dirty || ref.current.inFlight) { flush(true); event.preventDefault(); } };
    const onOnline = () => { if (ref.current.dirty) void save(); void syncNotes(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onUnload); window.removeEventListener('online', onOnline);
      if (ref.current.dirty && !ref.current.inFlight) void save({ keepalive: true });
      clearTimers();
    };
  }, [pageId]);

  // Poll the head while visible; a newer version with a clean editor reloads silently, with a dirty editor it surfaces the conflict.
  useEffect(() => {
    const id = setInterval(async () => {
      if (document.visibilityState !== 'visible' || ref.current.inFlight || ref.current.status === 'conflict') return;
      try {
        if ((await offlineNote(pageId).catch(() => undefined))?.pending) return;
        const head = await fetchHead(pageId);
        if (head.version > ref.current.version) {
          if (ref.current.dirty) dispatch({ type: 'conflict', head });
          else { remoteRef.current(); }
        }
      } catch { /* transient; the next poll retries */ }
    }, HEAD_POLL_MS);
    return () => clearInterval(id);
  }, [pageId]);

  const setVersion = useCallback((version: number, revision?: string) => { ref.current.version = version; localRevision.current = revision; dispatch({ type: 'version', version }); }, []);
  return { state, markDirty, flush, resolveConflict, setVersion, localRevision: () => localRevision.current, saveNow: () => save() };
}
