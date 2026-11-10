import { createStyleSpec } from '@blocknote/core';
import type { AppEditor } from './schema.ts';
import { AnnotationHighlights } from './annotationHighlights.ts';
import type { FloatingAnnotation } from './annotationHighlights.ts';

export const annotationStyle = createStyleSpec({ type: 'annotation', propSchema: 'string' }, {
  render: value => {
    const dom = document.createElement('span');
    dom.className = 'selection-annotation'; dom.dataset.annotationIds = value;
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

/** Project discussion state onto the view without rewriting versioned note content. */
export function updateAnnotationHighlights(editor: AppEditor, activeIds: ReadonlySet<string> | undefined, floating: readonly FloatingAnnotation[] = []): void {
  if (!editor.getExtension(AnnotationHighlights)) editor.registerExtension(AnnotationHighlights());
  editor.getExtension(AnnotationHighlights)!.setActiveIds(activeIds, floating);
}

/** Explicit removal affects only this discussion; overlapping anchors and other styles remain. */
export function removeAnnotation(editor: AppEditor, id: string): void {
  editor.transact(tr => {
    const mark = editor.pmSchema.marks.annotation!;
    const remaining = (value: string) => value.split(' ').filter(value => value && value !== id).join(' ');
    tr.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const previous = node.marks.find(item => item.type === mark)?.attrs.stringValue as string | undefined;
      if (!previous?.split(' ').includes(id)) return;
      tr.removeMark(pos, pos + node.nodeSize, mark);
      const ids = remaining(previous);
      if (ids) tr.addMark(pos, pos + node.nodeSize, mark.create({ stringValue: ids }));
    });
    const stored = (tr.storedMarks ?? tr.selection.$from.marks()).find(item => item.type === mark);
    if (stored?.attrs.stringValue && String(stored.attrs.stringValue).split(' ').includes(id)) {
      tr.removeStoredMark(mark);
      const ids = remaining(String(stored.attrs.stringValue));
      if (ids) tr.addStoredMark(mark.create({ stringValue: ids }));
    }
  });
}
