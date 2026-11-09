import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** View-only decorations let ProseMirror manage DOM changes without disturbing saved selections. */
export const AnnotationHighlights = createExtension(({ editor }) => {
  const key = new PluginKey('annotationHighlights');
  let activeIds: ReadonlySet<string> | undefined;
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
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })],
    setActiveIds(ids: ReadonlySet<string> | undefined) {
      activeIds = ids;
      editor.transact(tr => { tr.setMeta(key, true).setMeta('addToHistory', false); });
    },
  };
});
