import { useCallback } from 'react';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { useTree } from '../../../api/pages.ts';
import type { AppEditor } from '../schema.ts';

/** `@` menu: the user's active pages filtered by title. Full-text lookup is in the command palette. */
export function usePageMentionItems(editor: AppEditor, currentPageId: string) {
  const tree = useTree();
  return useCallback(async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const needle = query.trim().toLowerCase();
    const pages = (tree.data ?? []).filter(node => node.id !== currentPageId && node.kind !== 'row')
      .filter(node => !needle || (node.title || '無標題').toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    return pages.map(node => ({
      title: node.title || '無標題',
      subtext: node.kind === 'database' ? '資料庫' : '頁面',
      icon: node.icon ? (node.icon as unknown as DefaultReactSuggestionItem['icon']) : undefined,
      onItemClick: () => { editor.insertInlineContent([{ type: 'pageLink', props: { pageId: node.id, title: node.title } }, ' ']); },
    }));
  }, [tree.data, editor, currentPageId]);
}
