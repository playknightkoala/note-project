import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { PageHeadDto } from '@shared/api';
import { fetchHead, saveContent } from '../../api/pages.ts';
import { isApiError } from '../../api/client.ts';
import { hasDraft, isLocalWriter, offlineNote, resolveLocalNote, saveLocalContent, syncNotes } from '../../offline/notes.ts';
import type { LocalHead } from '../../offline/notes.ts';
import { OFFLINE_EVENT } from '../../offline/storage.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

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
/** How soon a save that was skipped for an open IME composition is tried again. */
const COMPOSING_RETRY_MS = 250;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const HEAD_POLL_MS = 30_000;

export interface AutosaveOptions {
  pageId: string;
  initialVersion: number;
  initialLocalRevision?: string;
  /**
   * Serializes the editor. Returns null while an IME composition is open, unless `force` is set: when the page is
   * being left, or the maximum wait has passed, the text typed so far must be saved as it stands.
   */
  getContent: (force?: boolean) => unknown[] | null;
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

  /**
   * While a conflict is unresolved nothing is uploaded, but the text must not exist only in memory: notes and rows
   * keep their draft on this device. Returns false when the draft could not be stored (no copy of the page on this
   * device, or another tab owns the newer local draft).
   */
  const keepDraft = useCallback(async (force = false): Promise<boolean> => {
    const r = ref.current;
    if (!r.dirty) return true;
    if (r.inFlight) return false;
    const content = getContentRef.current(force);
    if (!content) { arm(COMPOSING_RETRY_MS); return false; }
    r.inFlight = true; clearTimers();
    try {
      const kind = (await offlineNote(pageId).catch(() => undefined))?.local.page.kind;
      if (!kind || !hasDraft(kind)) return false;
      r.dirty = false;
      const head = await saveLocalContent(pageId, content, localRevision.current);
      localRevision.current = head.localRevision;
      return !r.dirty;
    } catch { r.dirty = true; return false; }
    finally { r.inFlight = false; }
  }, [pageId]);

  const save = useCallback(async (options: { keepalive?: boolean; overrideVersion?: number; force?: boolean } = {}): Promise<void> => {
    const r = ref.current;
    if (r.inFlight) return;
    if (r.status === 'conflict') { await keepDraft(options.force); return; }
    const overdue = r.firstDirtyAt > 0 && now() - r.firstDirtyAt >= MAX_WAIT_MS;
    const content = getContentRef.current(options.force || overdue);
    // An open composition postpones the save briefly; the max wait above still bounds how long text stays unsaved.
    if (!content) { if (!r.firstDirtyAt) r.firstDirtyAt = now(); arm(COMPOSING_RETRY_MS); return; }
    r.inFlight = true; r.dirty = false; r.firstDirtyAt = 0; clearTimers();
    dispatch({ type: 'saving' });
    try {
      const head: LocalHead = await saveContent(pageId, options.overrideVersion ?? r.version, content, { ...(options.keepalive ? { keepalive: true } : {}), overwrite: options.overrideVersion !== undefined, localRevision: localRevision.current });
      r.inFlight = false;
      // The ref is the source of truth for the next If-Match: a follow-up save may start before React re-renders.
      r.version = head.version;
      // Pages saved through the API (rows) have no local revision; keep the one the page was opened with.
      if (head.localRevision !== undefined) localRevision.current = head.localRevision;
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
  }, [pageId, keepDraft]);
  const stateAttempts = useRef(0); stateAttempts.current = state.attempts;

  /** (Re)starts the save timer without touching the first-dirty time. */
  const arm = (wait: number) => {
    const r = ref.current;
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => { r.timer = null; void save(); }, wait);
  };

  useUpdateGuard(async () => {
    const deadline = Date.now() + 10_000;
    while (ref.current.inFlight && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (ref.current.dirty && !ref.current.inFlight) await save();
    if (ref.current.inFlight || ref.current.dirty) throw new Error('筆記仍有尚未保存的修改；請先完成儲存或處理衝突，再更新。');
  });

  const schedule = useCallback((delay = DEBOUNCE_MS) => {
    const r = ref.current;
    if (!r.firstDirtyAt) r.firstDirtyAt = now();
    const sinceFirst = now() - r.firstDirtyAt;
    arm(Math.max(0, Math.min(delay, MAX_WAIT_MS - sinceFirst)));
  }, [save]);

  /** Call on every editor change outside a composition. */
  const markDirty = useCallback(() => { ref.current.dirty = true; dispatch({ type: 'dirty' }); schedule(); }, [schedule]);
  /** A change inside an open composition: remembered without re-rendering, saved on settle, on leave or at the max wait. */
  const markComposing = useCallback(() => { ref.current.dirty = true; schedule(); }, [schedule]);

  const flush = useCallback((keepalive = false, force = false) => { if (ref.current.dirty && !ref.current.inFlight) void save({ keepalive, force }); }, [save]);

  const resolveConflict = useCallback(async (choice: 'reload' | 'overwrite') => {
    const r = ref.current;
    clearTimers();
    const local = await offlineNote(pageId).catch(() => undefined);
    if (local && hasDraft(local.local.page.kind)) {
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
      // Notes and rows are edited through the local store. A database page has no text and is only cached there.
      if (!hasDraft(note.local.page.kind)) return;
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
    // Leaving cannot wait for an open composition to settle: save what has been typed so far.
    const onHide = () => { if (document.visibilityState === 'hidden') flush(true, true); };
    const onUnload = (event: BeforeUnloadEvent) => { if (ref.current.dirty || ref.current.inFlight) { flush(true, true); event.preventDefault(); } };
    const onOnline = () => { if (ref.current.dirty) void save(); void syncNotes(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onUnload); window.removeEventListener('online', onOnline);
      clearTimers();
      if (ref.current.dirty && !ref.current.inFlight) void save({ keepalive: true, force: true });
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
  /** Saves pending edits and resolves once they are stored on this device (or on the server, where there is no local copy). */
  const settle = useCallback(async () => {
    const deadline = now() + 10_000;
    while (ref.current.inFlight && now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (ref.current.dirty && !ref.current.inFlight) await save({ force: true });
  }, [save]);
  return { state, markDirty, markComposing, flush, resolveConflict, setVersion, localRevision: () => localRevision.current, saveNow: () => save(), settle, keepDraft,
    version: () => ref.current.version,
    /** Edits that exist only in this editor while a conflict blocks saving. */
    unsavedConflict: () => ref.current.status === 'conflict' && ref.current.dirty,
    hasUnsaved: () => ref.current.dirty || ref.current.inFlight };
}
