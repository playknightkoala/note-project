// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BlockNoteEditor } from '@blocknote/core';
import type { PartialBlock } from '@blocknote/core';
import { schema } from '../../src/client/features/editor/schema.ts';
import { findMatches, findReplace, foldCase } from '../../src/client/features/editor/findReplace.ts';
import { FindBar } from '../../src/client/features/editor/FindBar.tsx';

type Blocks = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[];
let editor: typeof schema.BlockNoteEditor;
let host: HTMLElement;
afterEach(() => { cleanup(); editor?._tiptapEditor.destroy(); document.body.replaceChildren(); });

/** Three occurrences of "check": plain, split across bold text, and inside a longer word in another block. */
const sample: Blocks = [
  { id: 'first', type: 'paragraph', content: [{ type: 'text', text: 'Check ', styles: {} }, { type: 'text', text: 'che', styles: { bold: true } }, { type: 'text', text: 'ck 待辦檢查', styles: {} }] },
  { id: 'second', type: 'heading', content: 'recheck 檢查清單' },
];
function create(content: Blocks = sample, mounted = true) {
  editor = BlockNoteEditor.create({ schema, initialContent: content });
  if (mounted) { host = document.createElement('div'); document.body.append(host); editor.mount(host); }
  return findReplace(editor);
}
const found = (query: string) => findMatches(editor.prosemirrorState.doc, query).map(match => editor.prosemirrorState.doc.textBetween(match.from, match.to));
const text = (index: number) => (editor.document[index]!.content as { text: string }[]).map(part => part.text).join('');

it('finds text without regard to case, across styled text and never across blocks', () => {
  create(sample, false);
  expect(found('check')).toEqual(['Check', 'check', 'check']);
  expect(found('CHECK')).toHaveLength(3);
  expect(found('檢查')).toEqual(['檢查', '檢查']);
  expect(found('檢查recheck')).toEqual([]);
  expect(found('')).toEqual([]);
  expect(found('沒有這段文字')).toEqual([]);
  // Lower-casing must not shift positions: "İ" becomes two characters in lower case.
  expect(foldCase('İA')).toHaveLength(2);
});

it('finds text in table cells, nested blocks and code blocks, and not across an inline page link', () => {
  create([
    { id: 'toggle', type: 'toggleListItem', content: '外層 alpha', children: [{ id: 'child', type: 'paragraph', content: '內層 Alpha' }] },
    { id: 'code', type: 'codeBlock', content: 'const alpha = 1;' },
    { id: 'table', type: 'table', content: { type: 'tableContent', rows: [{ cells: ['alpha 一', '二'] }, { cells: ['三', 'ALPHA'] }] } },
    { id: 'link', type: 'paragraph', content: [{ type: 'text', text: 'al', styles: {} }, { type: 'pageLink', props: { pageId: 'page-example', title: '頁面' } }, { type: 'text', text: 'pha', styles: {} }] },
  ] as Blocks, false);
  expect(found('alpha')).toEqual(['alpha', 'Alpha', 'alpha', 'alpha', 'ALPHA']);
});

it('highlights every match, moves between them in both directions and leaves the saved note untouched', () => {
  const finder = create();
  const before = JSON.stringify(editor.document);
  finder.search('check');
  expect(finder.store.state).toEqual({ query: 'check', total: 3, current: 0 });
  expect(host.querySelectorAll('.find-match')).toHaveLength(4); // the second match is drawn in two pieces (bold and plain)
  expect([...host.querySelectorAll('.find-match--current')].map(element => element.textContent).join('')).toBe('Check');
  finder.step(1);
  expect(finder.store.state.current).toBe(1);
  expect([...host.querySelectorAll('.find-match--current')].map(element => element.textContent).join('')).toBe('check');
  finder.step(1); finder.step(1);
  expect(finder.store.state.current).toBe(0);
  finder.step(-1);
  expect(finder.store.state.current).toBe(2);
  // Refining the search keeps looking from the selected match instead of jumping back to the top.
  finder.search('chec');
  expect(finder.store.state).toEqual({ query: 'chec', total: 3, current: 2 });
  finder.search('');
  expect(host.querySelector('.find-match')).toBeNull();
  expect(finder.store.state).toEqual({ query: '', total: 0, current: -1 });
  expect(JSON.stringify(editor.document)).toBe(before);
});

it('starts a new search at the given position and counts again when the page is edited', () => {
  const finder = create();
  let headingStart = 0;
  editor.prosemirrorState.doc.descendants((node, pos) => { if (node.attrs.id === 'second') headingStart = pos; });
  finder.search('check', headingStart);
  expect(finder.store.state).toEqual({ query: 'check', total: 3, current: 2 });
  editor.transact(tr => { tr.insertText('check ', 3); });
  expect(finder.store.state).toEqual({ query: 'check', total: 4, current: 3 });
});

it('replaces the selected match with the formatting of the text it replaces, then moves to the next one', () => {
  const finder = create();
  finder.search('check');
  expect(finder.replaceCurrent('確認')).toBe(true);
  expect(text(0)).toBe('確認 check 待辦檢查');
  expect(finder.store.state).toEqual({ query: 'check', total: 2, current: 0 });
  expect(finder.replaceCurrent('確認')).toBe(true);
  expect(editor.document[0]!.content).toMatchObject([{ text: '確認 ', styles: {} }, { text: '確認', styles: { bold: true } }, { text: ' 待辦檢查', styles: {} }]);
  expect(finder.store.state).toEqual({ query: 'check', total: 1, current: 0 });
  expect(finder.replaceCurrent('')).toBe(true);
  expect(text(1)).toBe('re 檢查清單');
  expect(finder.store.state).toEqual({ query: 'check', total: 0, current: -1 });
  expect(finder.replaceCurrent('確認')).toBe(false);
});

it('does not replace the same place twice when the new text contains the search text', () => {
  const finder = create();
  finder.search('check');
  finder.replaceCurrent('checked');
  expect(finder.store.state).toEqual({ query: 'check', total: 3, current: 1 });
  finder.replaceCurrent('checked'); finder.replaceCurrent('checked');
  expect(text(0)).toBe('checked checked 待辦檢查');
  expect(text(1)).toBe('rechecked 檢查清單');
});

it('replaces everything as one edit that a single undo takes back', () => {
  const finder = create();
  const before = JSON.stringify(editor.document);
  finder.search('檢查');
  expect(finder.replaceAll('核對')).toBe(2);
  expect(text(0)).toBe('Check check 待辦核對');
  expect(text(1)).toBe('recheck 核對清單');
  expect(finder.store.state).toEqual({ query: '檢查', total: 0, current: -1 });
  expect(finder.replaceAll('核對')).toBe(0);
  editor.undo();
  expect(JSON.stringify(editor.document)).toBe(before);
  expect(finder.store.state.total).toBe(2);
});

it('never changes a page that may only be read', () => {
  const finder = create();
  editor.isEditable = false;
  const before = JSON.stringify(editor.document);
  finder.search('check');
  expect(finder.store.state.total).toBe(3);
  expect(finder.replaceCurrent('x')).toBe(false);
  expect(finder.replaceAll('x')).toBe(0);
  expect(JSON.stringify(editor.document)).toBe(before);
});

const pressFind = () => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); act(() => { (document.activeElement ?? document.body).dispatchEvent(event); }); return event; };
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('opens with Ctrl+F, steps with Enter, replaces and closes with Escape', () => {
  create();
  render(<FindBar editor={() => editor} canReplace />);
  expect(screen.queryByRole('search')).toBeNull();
  expect(pressFind().defaultPrevented).toBe(true);
  const input = screen.getByLabelText('尋找文字');
  expect(document.activeElement).toBe(input);
  type('尋找文字', 'check');
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('1 / 3');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('2 / 3');
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.click(screen.getByRole('button', { name: '下一個' }));
  fireEvent.click(screen.getByRole('button', { name: '上一個' }));
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('1 / 3');

  expect(screen.queryByLabelText('取代為')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '取代' }));
  type('取代為', '確認');
  fireEvent.keyDown(screen.getByLabelText('取代為'), { key: 'Enter' });
  expect(text(0)).toBe('確認 check 待辦檢查');
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('1 / 2');
  fireEvent.click(screen.getByRole('button', { name: '全部取代' }));
  expect(text(0)).toBe('確認 確認 待辦檢查');
  expect(text(1)).toBe('re確認 檢查清單');
  expect(screen.getAllByRole('status').map(element => element.textContent)).toEqual(['無結果', '已取代 2 處']);
  expect(screen.getByRole('button', { name: '全部取代' }).hasAttribute('disabled')).toBe(true);

  type('尋找文字', '檢查');
  expect(host.querySelectorAll('.find-match')).toHaveLength(2);
  fireEvent.keyDown(screen.getByLabelText('尋找文字'), { key: 'Escape' });
  expect(screen.queryByRole('search')).toBeNull();
  expect(host.querySelector('.find-match')).toBeNull();
  // Opening again brings the last search back.
  pressFind();
  expect((screen.getByLabelText('尋找文字') as HTMLInputElement).value).toBe('檢查');
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('1 / 2');
});

it('offers no replacement on a page that may only be read', () => {
  create();
  render(<FindBar editor={() => editor} canReplace={false} />);
  pressFind();
  type('尋找文字', 'check');
  expect(screen.getByRole('status').textContent).toBe('1 / 3');
  expect(screen.queryByRole('button', { name: '取代' })).toBeNull();
});

it('does not act on Enter while an input method is composing', () => {
  create();
  render(<FindBar editor={() => editor} canReplace />);
  pressFind();
  type('尋找文字', 'check');
  fireEvent.keyDown(screen.getByLabelText('尋找文字'), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(screen.getByLabelText('尋找文字'), { key: 'Enter', keyCode: 229 });
  expect(screen.getAllByRole('status')[0]!.textContent).toBe('1 / 3');
});

it('hands a second Ctrl+F to the browser, and stays out of the way of a dialog or a page without text', () => {
  create();
  const view = render(<FindBar editor={() => editor} canReplace />);
  pressFind();
  type('尋找文字', 'check');
  expect(pressFind().defaultPrevented).toBe(false);
  expect(screen.queryByRole('search')).toBeNull();
  expect(host.querySelector('.find-match')).toBeNull();

  const dialog = document.createElement('div'); dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog);
  expect(pressFind().defaultPrevented).toBe(false);
  expect(screen.queryByRole('search')).toBeNull();
  dialog.remove();

  view.rerender(<FindBar editor={() => null} canReplace />);
  expect(pressFind().defaultPrevented).toBe(false);
  expect(screen.queryByRole('search')).toBeNull();
});
