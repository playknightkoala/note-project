// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../src/client/features/editor/schema.ts';
import { markAnnotation, removeAnnotation, updateAnnotationHighlights } from '../../src/client/features/editor/annotationStyle.ts';

let editor: typeof schema.BlockNoteEditor;
afterEach(() => { editor?._tiptapEditor.destroy(); document.body.replaceChildren(); });

it('retains overlapping anchors in block JSON through text edits and reserialization', () => {
  editor = BlockNoteEditor.create({ schema, initialContent: [{ id: 'block-one', type: 'paragraph', content: 'ABCDE' }] });
  const mount = document.createElement('div'); document.body.append(mount); editor.mount(mount);
  let start = 0;
  editor.prosemirrorState.doc.descendants((node, pos) => { if (node.isText) start = pos; });
  markAnnotation(editor, start, start + 3, 'first');
  markAnnotation(editor, start + 1, start + 4, 'second');
  const content = editor.document[0]!.content;
  expect(content).toMatchObject([
    { text: 'A', styles: { annotation: 'first' } },
    { text: 'BC', styles: { annotation: 'first second' } },
    { text: 'D', styles: { annotation: 'second' } }, { text: 'E' },
  ]);
  editor.transact(tr => { tr.insertText('新', start + 2); });
  expect(JSON.stringify(editor.document)).toContain('first second');
  const saved = JSON.parse(JSON.stringify(editor.document)) as typeof editor.document;
  editor.replaceBlocks(editor.document, saved);
  expect(JSON.stringify(editor.document)).toContain('first second');
  expect(mount.querySelector('[data-annotation-ids="first second"]')).toBeTruthy();
});

it('removes just one discussion across overlapping ranges without losing text or other formatting', () => {
  editor = BlockNoteEditor.create({ schema, initialContent: [{ id: 'block-one', type: 'paragraph', content: [{ type: 'text', text: 'ABCDE', styles: { bold: true } }] }] });
  let start = 0;
  editor.prosemirrorState.doc.descendants((node, pos) => { if (node.isText) start = pos; });
  markAnnotation(editor, start, start + 3, 'first');
  markAnnotation(editor, start + 1, start + 4, 'second');
  removeAnnotation(editor, 'first');
  expect(editor.document[0]!.content).toMatchObject([
    { text: 'A', styles: { bold: true } },
    { text: 'BCD', styles: { bold: true, annotation: 'second' } },
    { text: 'E', styles: { bold: true } },
  ]);
  removeAnnotation(editor, 'second');
  expect(editor.document[0]!.content).toEqual([{ type: 'text', text: 'ABCDE', styles: { bold: true } }]);
});

it('keeps an overlapping active discussion highlighted without rewriting saved anchors', () => {
  editor = BlockNoteEditor.create({ schema, initialContent: [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: '原文', styles: { annotation: 'resolved active' } }] }] });
  const host = document.createElement('div'); document.body.append(host); editor.mount(host);
  const before = JSON.stringify(editor.document);
  updateAnnotationHighlights(editor, new Set(['active']));
  expect(host.querySelector('.annotation-highlight')?.textContent).toBe('原文');
  updateAnnotationHighlights(editor, new Set());
  expect(host.querySelector('.annotation-highlight')).toBeNull();
  expect(JSON.stringify(editor.document)).toBe(before);
});
