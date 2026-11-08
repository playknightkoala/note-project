import type { DefaultReactSuggestionItem } from '@blocknote/react';
import type { NavigateFunction } from 'react-router';
import type { AppEditor } from './schema.ts';
import { api } from '../../api/client.ts';
import type { PageResponse } from '@shared/api';
import { queryClient } from '../../app/providers.tsx';
import { pageKeys } from '../../api/pages.ts';

/** Notion-style extras ahead of the default block items: a child page and a child database. */
export function slashItems(editor: AppEditor, pageId: string, navigate: NavigateFunction): DefaultReactSuggestionItem[] {
  const create = async (kind: 'page' | 'database') => {
    const response = await api<PageResponse>('POST', '/api/pages', { json: { parentId: pageId, kind } });
    void queryClient.invalidateQueries({ queryKey: pageKeys.tree });
    editor.insertInlineContent([{ type: 'pageLink', props: { pageId: response.page.id, title: response.page.title } }, ' ']);
    navigate(`/p/${response.page.id}`);
  };
  return [
    { title: '子頁面', subtext: '在這個頁面底下建立新頁面', aliases: ['page', 'subpage', '頁面'], group: '頁面', onItemClick: () => { void create('page'); } },
    { title: '資料庫（表格）', subtext: '建立一個帶屬性欄位的表格', aliases: ['database', 'table', '資料庫', '表格'], group: '頁面', onItemClick: () => { void create('database'); } },
    { title: '提及頁面', subtext: '以 @ 連結到其他頁面', aliases: ['mention', 'link', '連結'], group: '頁面', onItemClick: () => { editor.insertInlineContent('@'); } },
  ];
}
