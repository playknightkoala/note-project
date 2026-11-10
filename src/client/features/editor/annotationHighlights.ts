import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * A discussion started by someone who may not write the page. Its text carries no mark: the quote is looked up in
 * the commented blocks each time, so nothing such a reader does can change the page.
 */
export interface FloatingAnnotation { id: string; quote: string; blockIds: string[] }

/** The block's own text (not that of blocks nested below it) with the document position of every character. */
function ownText(block: Node, at: number): { text: string; positions: number[] } {
  let text = ''; const positions: number[] = [];
  const content = block.firstChild;
  if (!content || content.type.spec.group?.includes('bnBlock')) return { text, positions };
  content.descendants((node, offset) => {
    if (!node.isText || !node.text) return;
    const start = at + 2 + offset;
    for (let index = 0; index < node.text.length; index++) positions.push(start + index);
    text += node.text;
  });
  return { text, positions };
}

/** Where a floating discussion's quote is still found: each of its lines in the first commented block that has it. */
export function locateQuote(doc: Node, item: FloatingAnnotation): { from: number; to: number }[] {
  const wanted = new Set(item.blockIds), blocks: { text: string; positions: number[] }[] = [];
  doc.descendants((node, pos) => { if (typeof node.attrs.id === 'string' && wanted.has(node.attrs.id)) blocks.push(ownText(node, pos)); });
  const found: { from: number; to: number }[] = [];
  let next = 0;
  for (const line of item.quote.split('\n').map(part => part.trim()).filter(Boolean)) {
    for (let index = next; index < blocks.length; index++) {
      const start = blocks[index]!.text.indexOf(line);
      if (start < 0) continue;
      const positions = blocks[index]!.positions;
      // Characters next to each other in the text may be apart in the document (an inline chip between them).
      let from = positions[start]!;
      for (let offset = 1; offset <= line.length; offset++) {
        const position = positions[start + offset];
        if (offset === line.length || position !== positions[start + offset - 1]! + 1) { found.push({ from, to: positions[start + offset - 1]! + 1 }); from = position!; }
      }
      next = index + 1;
      break;
    }
  }
  return found;
}

/** View-only decorations let ProseMirror manage DOM changes without disturbing saved selections. */
export const AnnotationHighlights = createExtension(({ editor }) => {
  const key = new PluginKey('annotationHighlights');
  let activeIds: ReadonlySet<string> | undefined;
  let floating: readonly FloatingAnnotation[] = [];
  return {
    key: 'annotationHighlights',
    prosemirrorPlugins: [new Plugin({
      key,
      props: {
        decorations(state) {
          const decorations: Decoration[] = [];
          const visible = activeIds;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const ids = node.marks.find(mark => mark.type.name === 'annotation')?.attrs.stringValue as string | undefined;
            if (ids && (visible === undefined || ids.split(' ').some(id => visible.has(id)))) {
              decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'annotation-highlight', title: '查看留言與表情反應' }));
            }
          });
          for (const item of floating) {
            for (const range of locateQuote(state.doc, item)) {
              decorations.push(Decoration.inline(range.from, range.to, { class: 'annotation-highlight', title: '查看留言與表情反應', 'data-annotation-ids': item.id }));
            }
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })],
    setActiveIds(ids: ReadonlySet<string> | undefined, shown: readonly FloatingAnnotation[] = []) {
      activeIds = ids; floating = shown;
      editor.transact(tr => { tr.setMeta(key, true).setMeta('addToHistory', false); });
    },
  };
});
