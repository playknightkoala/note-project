import { useCallback, useEffect, useRef } from 'react';
import type { AppEditor } from './schema.ts';

type Bookmark = ReturnType<AppEditor['prosemirrorState']['selection']['getBookmark']>;

/** Keep the intended range while an editor menu owns focus, mapping it through document edits. */
export function useSavedSelection(editor: AppEditor) {
  const saved = useRef<{ bookmark: Bookmark; empty: boolean } | null>(null);
  useEffect(() => editor.onBeforeChange(({ tr }) => {
    if (saved.current && tr.docChanged) saved.current.bookmark = saved.current.bookmark.map(tr.mapping);
  }), [editor]);
  const capture = useCallback(() => {
    const selection = editor.prosemirrorState.selection;
    saved.current = { bookmark: selection.getBookmark(), empty: selection.empty };
  }, [editor]);
  const restore = useCallback(() => {
    if (!saved.current) return false;
    const selection = saved.current.bookmark.resolve(editor.prosemirrorState.doc);
    // A range deleted while the menu was open must not format a neighbouring paragraph instead.
    if (!saved.current.empty && selection.empty) return false;
    if (!selection.eq(editor.prosemirrorState.selection)) editor.transact(tr => { tr.setSelection(selection); });
    return true;
  }, [editor]);
  const clear = useCallback(() => { saved.current = null; }, []);
  return { capture, restore, clear };
}
