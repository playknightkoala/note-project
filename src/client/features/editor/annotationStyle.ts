import { createStyleSpec } from '@blocknote/core';
import type { AppEditor } from './schema.ts';

export const annotationStyle = createStyleSpec({ type: 'annotation', propSchema: 'string' }, {
  render: value => {
    const dom = document.createElement('span');
    dom.className = 'selection-annotation'; dom.dataset.annotationIds = value;
    dom.title = '查看留言與表情反應';
    return { dom, contentDOM: dom };
  },
  toExternalHTML: () => { const dom = document.createElement('span'); return { dom, contentDOM: dom }; },
});

/** Marks follow text through normal edits and are persisted in the official block JSON. */
export function markAnnotation(editor: AppEditor, from: number, to: number, id: string) {
  editor.transact(tr => {
    const mark = editor.pmSchema.marks.annotation!;
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText || !tr.doc.resolve(pos).parent.type.allowsMarkType(mark)) return;
      const previous = node.marks.find(item => item.type === mark)?.attrs.stringValue as string | undefined;
      const ids = [...new Set([...(previous?.split(' ') ?? []), id])].join(' ');
      tr.addMark(Math.max(pos, from), Math.min(pos + node.nodeSize, to), mark.create({ stringValue: ids }));
    });
  });
}
