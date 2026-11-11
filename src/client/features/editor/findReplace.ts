import { createExtension, createStore } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { AppEditor } from './schema.ts';

export interface FindMatch { from: number; to: number }
/** What the find bar shows: `current` is the index of the selected match, -1 when nothing matches. */
export interface FindSnapshot { query: string; total: number; current: number }

/** Stands in for an inline chip or line break, which no query can match across. */
const BREAK = '￼';

/** Lower-cases without changing the length of the text, so an offset in the result is an offset in the original. */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = '';
  for (const char of text) { const small = char.toLowerCase(); folded += small.length === char.length ? small : char; }
  return folded;
}

/**
 * Every occurrence of the query in the document's text, ignoring case. A match stays inside one text block (a
 * paragraph, a heading, a table cell, a code block) but may run across differently styled text.
 */
export function findMatches(doc: Node, query: string): FindMatch[] {
  const needle = foldCase(query);
  if (!needle || needle.includes(BREAK)) return [];
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) { text += BREAK; positions.push(-1); return; }
      for (let index = 0; index < child.text.length; index++) positions.push(pos + 1 + offset + index);
      text += child.text;
    });
    const haystack = foldCase(text);
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      matches.push({ from: positions[at]!, to: positions[at + needle.length - 1]! + 1 });
    }
    return false;
  });
  return matches;
}

interface FindState { query: string; matches: FindMatch[]; current: number; anchor: number; decorations: DecorationSet }
type FindMeta = { query: string; anchor?: number } | { step: 1 | -1 } | { after: number };

const key = new PluginKey<FindState>('findReplace');
const idle: FindState = { query: '', matches: [], current: -1, anchor: 0, decorations: DecorationSet.empty };

/** The first match starting at or after the position; searching wraps around to the top. */
function matchFrom(matches: FindMatch[], position: number): number {
  if (!matches.length) return -1;
  const index = matches.findIndex(match => match.from >= position);
  return index < 0 ? 0 : index;
}

/**
 * Find and replace inside the page's text. Matches are view-only decorations, so searching never changes the saved
 * note; only a replacement does, as one undoable edit.
 */
export const FindReplace = createExtension(({ editor }) => {
  const store = createStore<FindSnapshot>({ query: '', total: 0, current: -1 });
  const state = () => key.getState(editor.prosemirrorState) ?? idle;
  const sync = () => {
    const { query, matches, current } = state();
    const shown = store.state;
    if (shown.query !== query || shown.total !== matches.length || shown.current !== current) store.setState({ query, total: matches.length, current });
  };
  const send = (meta: FindMeta) => {
    editor.transact(tr => { tr.setMeta(key, meta).setMeta('addToHistory', false); });
    sync();
  };
  /** Brings the selected match on screen, opening the collapsed toggles it is inside. */
  const reveal = () => {
    const element = editor.domElement?.querySelector<HTMLElement>('.find-match--current');
    if (!element) return;
    for (let group = element.closest('.bn-toggle-slot > .bn-block-group'); group; group = group.parentElement?.closest('.bn-toggle-slot > .bn-block-group') ?? null) {
      group.closest('.bn-toggle-frame')?.querySelector<HTMLElement>(':scope > .bn-toggle-button[aria-expanded="false"]')?.click();
    }
    const box = element.getBoundingClientRect();
    // The top of the window is taken by the page bar and the find bar itself.
    const covered = (document.querySelector('.find-bar')?.getBoundingClientRect().bottom ?? 100) + 12;
    if (box.top < covered || box.bottom > window.innerHeight - 48 || box.left < 0 || box.right > window.innerWidth) element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  };
  return {
    key: 'findReplace',
    store,
    prosemirrorPlugins: [new Plugin<FindState>({
      key,
      state: {
        init: () => idle,
        apply(tr, previous) {
          const meta = tr.getMeta(key) as FindMeta | undefined;
          if (!meta && (!tr.docChanged || !previous.query)) return previous;
          let { query, matches, current, anchor } = previous;
          if (meta && 'query' in meta) { query = meta.query; anchor = meta.anchor ?? anchor; }
          if (tr.docChanged || (meta && 'query' in meta)) {
            const selected = previous.matches[previous.current];
            matches = findMatches(tr.doc, query);
            current = matchFrom(matches, meta && 'after' in meta ? meta.after
              : meta && 'query' in meta ? anchor
                : selected ? tr.mapping.map(selected.from, -1) : tr.mapping.map(anchor));
          }
          if (meta && 'step' in meta && matches.length) current = (current + meta.step + matches.length) % matches.length;
          anchor = matches[current]?.from ?? Math.min(tr.mapping.map(anchor), tr.doc.content.size);
          const decorations = DecorationSet.create(tr.doc, matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === current ? 'find-match find-match--current' : 'find-match' })));
          return { query, matches, current, anchor, decorations };
        },
      },
      props: { decorations: editorState => key.getState(editorState)?.decorations ?? DecorationSet.empty },
      // Typing in the page while the bar is open changes the count.
      view: () => ({ update: sync }),
    })],
    /** Searches for the text. A new search starts looking from `anchor`; a refined one stays at the selected match. */
    search(query: string, anchor?: number) {
      if (!query && !state().query && anchor === undefined) return;
      send(anchor === undefined ? { query } : { query, anchor });
      reveal();
    },
    step(direction: 1 | -1) {
      if (!state().matches.length) return;
      send({ step: direction });
      reveal();
    },
    /** Replaces the selected match and moves on to the next one. */
    replaceCurrent(replacement: string): boolean {
      const { matches, current } = state();
      const match = matches[current];
      if (!match || !editor.isEditable) return false;
      editor.transact(tr => { replaceRange(tr, match, replacement); tr.setMeta(key, { after: match.from + replacement.length } satisfies FindMeta); });
      sync(); reveal();
      return true;
    },
    /** Replaces every match in one edit, so a single undo brings all of them back. */
    replaceAll(replacement: string): number {
      const { matches, anchor } = state();
      if (!matches.length || !editor.isEditable) return 0;
      editor.transact(tr => {
        for (let index = matches.length - 1; index >= 0; index--) replaceRange(tr, matches[index]!, replacement);
        tr.setMeta(key, { after: tr.mapping.map(anchor, -1) } satisfies FindMeta);
      });
      sync();
      return matches.length;
    },
    /** Where the selected match is, for putting the cursor there when the bar closes. */
    currentMatch(): FindMatch | undefined { const { matches, current } = state(); return matches[current]; },
  };
});

/** The replacement takes the formatting of the first character it replaces. */
function replaceRange(tr: Transaction, match: FindMatch, replacement: string) {
  if (!replacement) { tr.delete(match.from, match.to); return; }
  tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(replacement, tr.doc.nodeAt(match.from)?.marks ?? []));
}

export function findReplace(editor: AppEditor) {
  if (!editor.getExtension(FindReplace)) editor.registerExtension(FindReplace());
  return editor.getExtension(FindReplace)!;
}
