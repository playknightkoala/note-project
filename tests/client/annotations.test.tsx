// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { schema } from '../../src/client/features/editor/schema.ts';
import { markAnnotation } from '../../src/client/features/editor/annotationStyle.ts';

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
