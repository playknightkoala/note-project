import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface UiState {
  expanded: ReadonlySet<string>;
  setExpanded: (id: string, open: boolean) => void;
  expandMany: (ids: string[]) => void;
  lastPageId: string | null;
  rememberPage: (id: string) => void;
}

const UiContext = createContext<UiState | null>(null);
const EXPANDED_KEY = 'notes:expanded';
const LAST_PAGE_KEY = 'notes:last-page';

function readJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set(readJson<string[]>(EXPANDED_KEY, [])));
  const [lastPageId, setLastPageId] = useState<string | null>(() => readJson<string | null>(LAST_PAGE_KEY, null));
  const persist = (next: Set<string>) => { setExpandedState(next); writeJson(EXPANDED_KEY, [...next]); };
  const setExpanded = useCallback((id: string, open: boolean) => {
    setExpandedState(current => { const next = new Set(current); if (open) next.add(id); else next.delete(id); writeJson(EXPANDED_KEY, [...next]); return next; });
  }, []);
  const expandMany = useCallback((ids: string[]) => {
    setExpandedState(current => { if (ids.every(id => current.has(id))) return current; const next = new Set(current); for (const id of ids) next.add(id); writeJson(EXPANDED_KEY, [...next]); return next; });
  }, []);
  const rememberPage = useCallback((id: string) => { setLastPageId(id); writeJson(LAST_PAGE_KEY, id); }, []);
  void persist;
  const value = useMemo<UiState>(() => ({ expanded, setExpanded, expandMany, lastPageId, rememberPage }), [expanded, setExpanded, expandMany, lastPageId, rememberPage]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUiState(): UiState {
  const value = useContext(UiContext);
  if (!value) throw new Error('UiStateProvider missing');
  return value;
}

/**
 * Opening a page shows what is directly under it. The page is expanded once per visit, so collapsing it by hand holds until it is opened again.
 * `hasChildren` is undefined while the page is not known to the tree that calls this (still loading, or the page belongs to another tree).
 */
export function useExpandOnOpen(pageId: string | null, hasChildren: boolean | undefined): void {
  const { setExpanded } = useUiState();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!pageId || hasChildren === undefined) { handled.current = null; return; }
    if (handled.current === pageId) return;
    handled.current = pageId;
    if (hasChildren) setExpanded(pageId, true);
  }, [pageId, hasChildren, setExpanded]);
}
