import { useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';
import { createPortal } from 'react-dom';
import { TextSelection } from '@tiptap/pm/state';
import { ArrowDown, ArrowUp, CornerDownLeft, Repeat2, X } from 'lucide-react';
import { findReplace } from './findReplace.ts';
import type { FindSnapshot } from './findReplace.ts';
import type { AppEditor } from './schema.ts';

export interface FindBarHandle { open: () => void }
type Finder = ReturnType<typeof findReplace>;

const NOTHING: FindSnapshot = { query: '', total: 0, current: -1 };
/** On a Mac, Ctrl+F moves the cursor in a text field; find is ⌘F there and Ctrl+F everywhere else. */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const withMod = (event: KeyboardEvent | ReactKeyboardEvent) => (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey;

/** The text selected on screen inside the editor, read from the page itself so that it also works on a read-only page. */
function selectedRange(editor: AppEditor): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return editor.domElement?.contains(range.commonAncestorContainer) ? range : null;
}

/** Where a new search starts: at the selection or the cursor, otherwise at the top of what is on screen. */
function searchStart(editor: AppEditor, selected: Range | null): number {
  try {
    const view = editor.prosemirrorView;
    if (selected) return view.posAtDOM(selected.startContainer, selected.startOffset);
    if (view.hasFocus()) return editor.prosemirrorState.selection.from;
    const box = view.dom.getBoundingClientRect();
    return box.top >= 0 ? 0 : view.posAtCoords({ left: box.left + 8, top: 56 })?.pos ?? 0;
  } catch { return 0; }
}

/**
 * Find (and, where the page may be edited, replace) in the page's text, in place of the browser's own find.
 * Ctrl/⌘+F opens it; pressed again while the field has focus, it hands over to the browser's find.
 */
export function FindBar({ editor: getEditor, canReplace, ref }: { editor: () => AppEditor | null; canReplace: boolean; ref?: Ref<FindBarHandle> }) {
  const [opened, setOpened] = useState(false);
  const [finder, setFinder] = useState<Finder | null>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef({ opened, finder, query }); live.current = { opened, finder, query };
  const snapshot = useSyncExternalStore(
    useCallback((changed: () => void) => finder ? finder.store.subscribe(changed) : () => {}, [finder]),
    () => finder?.store.state ?? NOTHING,
  );

  const open = useCallback((): boolean => {
    const editor = getEditor();
    if (!editor) return false;
    const next = findReplace(editor);
    // Selected words are what the user most likely wants to look for.
    const range = selectedRange(editor);
    const selected = range?.toString() ?? '';
    const text = selected && selected.length <= 200 && !/[\r\n]/.test(selected) ? selected : live.current.query;
    setFinder(next); setQuery(text); setNotice(''); setOpened(true); setFocusTick(tick => tick + 1);
    next.search(text, searchStart(editor, range));
    return true;
  }, [getEditor]);
  useImperativeHandle(ref, () => ({ open: () => { open(); } }), [open]);

  const close = useCallback((toEditor: boolean) => {
    const current = live.current.finder;
    const match = current?.currentMatch();
    current?.search('');
    setOpened(false); setNotice('');
    const editor = getEditor();
    if (!toEditor || !editor?.isEditable) return;
    // Like the browser's find: closing leaves the cursor at what was found (and opening again finds it first).
    if (match) editor.transact(tr => { tr.setSelection(TextSelection.create(tr.doc, match.from)).setMeta('addToHistory', false); });
    editor.focus();
  }, [getEditor]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (withMod(event) && !event.shiftKey && key === 'f') {
        // A dialog in front of the page is the browser's to search.
        if (document.querySelector('[aria-modal="true"]')) return;
        if (live.current.opened && document.activeElement === inputRef.current) { close(false); return; }
        if (open()) event.preventDefault();
        return;
      }
      if (live.current.opened && withMod(event) && key === 'g') { event.preventDefault(); live.current.finder?.step(event.shiftKey ? -1 : 1); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open, close]);
  useEffect(() => { if (opened) { inputRef.current?.focus(); inputRef.current?.select(); } }, [opened, focusTick]);
  // The highlights belong to the open bar: leaving the page (or the bar going away) removes them.
  useEffect(() => () => { try { live.current.finder?.search(''); } catch { /* the editor is already gone */ } }, []);

  if (!opened || !finder) return null;
  const replaceShown = canReplace && replaceOpen;
  const search = (text: string) => { setQuery(text); setNotice(''); finder.search(text); };
  const replaceOne = () => { if (finder.replaceCurrent(replacement)) setNotice(''); };
  const replaceAll = () => { const count = finder.replaceAll(replacement); if (count) setNotice(`已取代 ${count} 處`); };
  const composing = (event: ReactKeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  // Hung below the page's top bar, so it follows the bar and never covers its buttons.
  const dock = document.querySelector<HTMLElement>('.page > .topbar');
  const bar = <div className={`find-bar${dock ? ' find-bar--docked' : ''}`} role="search" aria-label="在頁面中尋找" data-native-context-menu
    onKeyDown={event => { if (event.key === 'Escape' && !composing(event)) { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <div className="find-bar__row">
      <input ref={inputRef} className="find-bar__input" value={query} placeholder="尋找…" aria-label="尋找文字" spellCheck={false} autoComplete="off" enterKeyHint="search"
        onChange={event => search(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); finder.step(event.shiftKey ? -1 : 1); } }} />
      <span className="find-bar__count" role="status">{query ? snapshot.total ? `${snapshot.current + 1} / ${snapshot.total}` : '無結果' : ''}</span>
      <button type="button" className="find-bar__icon" aria-label="上一個" title="上一個（Shift Enter）" disabled={!snapshot.total} onMouseDown={keepFocus} onClick={() => finder.step(-1)}><ArrowUp size={16} /></button>
      <button type="button" className="find-bar__icon" aria-label="下一個" title="下一個（Enter）" disabled={!snapshot.total} onMouseDown={keepFocus} onClick={() => finder.step(1)}><ArrowDown size={16} /></button>
      {canReplace && <button type="button" className={`find-bar__icon${replaceOpen ? ' find-bar__icon--active' : ''}`} aria-label="取代" title="取代" aria-pressed={replaceOpen} onMouseDown={keepFocus} onClick={() => setReplaceOpen(value => !value)}><Repeat2 size={16} /></button>}
      <button type="button" className="find-bar__icon" aria-label="關閉尋找" title="關閉（Esc）" onClick={() => close(false)}><X size={17} /></button>
    </div>
    {replaceShown && <div className="find-bar__replace">
      <input className="find-bar__input" value={replacement} placeholder="取代為…" aria-label="取代為" spellCheck={false} autoComplete="off"
        onChange={event => setReplacement(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || composing(event)) return;
          event.preventDefault();
          if (withMod(event)) replaceAll(); else replaceOne();
        }} />
      <div className="find-bar__actions">
        <span className="find-bar__notice" role="status">{notice}</span>
        <button type="button" className="find-bar__button" title={`全部取代（${isMac ? '⌘' : 'Ctrl'} Enter）`} disabled={!snapshot.total} onClick={replaceAll}>全部取代</button>
        <button type="button" className="find-bar__button find-bar__button--primary" disabled={!snapshot.total} onClick={replaceOne}>取代<CornerDownLeft size={14} /></button>
      </div>
    </div>}
  </div>;
  return dock ? createPortal(bar, dock) : bar;
}
