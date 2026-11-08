import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { Alert, Button, Center, Group, Loader, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { PageResponse } from '@shared/api';
import { pageKeys, usePage, usePatchPage } from '../../api/pages.ts';
import { isApiError } from '../../api/client.ts';
import { useUiState } from '../../app/uiState.tsx';
import { BlockEditor } from '../editor/BlockEditor.tsx';
import type { AppEditor } from '../editor/schema.ts';
import type { schema } from '../editor/schema.ts';
import { TopBar } from '../shell/TopBar.tsx';
import { PageTitle } from './PageTitle.tsx';
import { useAutosave } from './useAutosave.ts';

type Blocks = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[];

export function PageRoute() {
  const { pageId = '' } = useParams();
  const page = usePage(pageId);
  if (page.isPending) return <Center h="60vh"><Loader size="sm" /></Center>;
  if (page.error || !page.data) {
    return <Center h="60vh"><Text c="dimmed">{isApiError(page.error, 404) ? '找不到這個頁面，可能已被刪除。' : '無法載入頁面。'}</Text></Center>;
  }
  return <PageView key={pageId} initial={page.data} />;
}

function PageView({ initial }: { initial: PageResponse }) {
  const pageId = initial.page.id;
  const queryClient = useQueryClient();
  const patch = usePatchPage();
  const { rememberPage, expandMany } = useUiState();
  const editorRef = useRef<AppEditor | null>(null);
  const composingRef = useRef<() => boolean>(() => false);
  const [meta, setMeta] = useState({ title: initial.page.title, icon: initial.page.icon, fullWidth: initial.page.fullWidth });
  useEffect(() => { rememberPage(pageId); expandMany(initial.breadcrumbs.slice(0, -1).map(b => b.id)); }, [pageId, rememberPage, expandMany, initial.breadcrumbs]);

  const replaceContent = useCallback((content: unknown[]) => {
    const editor = editorRef.current; if (!editor) return;
    const stop = editor.onBeforeChange(({ tr }) => { tr.setMeta('addToHistory', false); });
    try { editor.replaceBlocks(editor.document, content as Blocks); } finally { stop(); }
  }, []);

  const autosave = useAutosave({
    pageId, initialVersion: initial.page.version,
    getContent: () => (composingRef.current() || !editorRef.current) ? null : editorRef.current.document as unknown[],
    onRemoteUpdate: () => {
      void queryClient.fetchQuery({ queryKey: pageKeys.page(pageId), queryFn: () => import('../../api/client.ts').then(m => m.api<PageResponse>('GET', `/api/pages/${pageId}`)) })
        .then(fresh => { replaceContent(fresh.page.content); setMeta({ title: fresh.page.title, icon: fresh.page.icon, fullWidth: fresh.page.fullWidth }); autosave.setVersion(fresh.page.version); });
    },
  });

  const onReady = useCallback((editor: AppEditor, isComposing: () => boolean) => { editorRef.current = editor; composingRef.current = isComposing; }, []);
  const onChange = useCallback(() => autosave.markDirty(), [autosave]);
  const onCompositionSettled = useCallback(() => autosave.markDirty(), [autosave]);
  const saveTitle = useCallback((title: string) => { setMeta(m => ({ ...m, title })); patch.mutate({ id: pageId, title }); }, [patch, pageId]);
  const focusEditor = useCallback(() => {
    const editor = editorRef.current; if (!editor) return;
    const first = editor.document[0]; if (first) editor.setTextCursorPosition(first, 'start');
    editor.focus();
  }, []);
  const initialContent = useMemo(() => initial.page.content as Blocks, [initial.page.content]);

  return <div className="page">
    <TopBar page={{ id: pageId, kind: initial.page.kind, title: meta.title, icon: meta.icon, fullWidth: meta.fullWidth }} breadcrumbs={initial.breadcrumbs}
      saveStatus={autosave.state.status} saveError={autosave.state.error} onRetry={() => { void autosave.saveNow(); }}
      onToggleFullWidth={() => { const fullWidth = !meta.fullWidth; setMeta(m => ({ ...m, fullWidth })); patch.mutate({ id: pageId, fullWidth }); }} />
    {autosave.state.status === 'conflict' && <Alert color="red" variant="light" className="conflict-bar" title="此頁面已在其他地方更新">
      <Group gap="sm">
        <Text size="sm">你可以載入最新版本（會捨棄這裡尚未儲存的修改），或以這裡的內容覆蓋（被覆蓋的版本會留在頁面歷史）。</Text>
        <Button size="xs" onClick={() => { void autosave.resolveConflict('reload'); }}>載入最新版本</Button>
        <Button size="xs" variant="default" onClick={() => { void autosave.resolveConflict('overwrite'); }}>以我的內容覆蓋</Button>
      </Group>
    </Alert>}
    <div className={`page-body${meta.fullWidth ? ' page-body--full' : ''}`}>
      <header className="page-header">
        {meta.icon && <div className="page-icon" aria-hidden>{meta.icon}</div>}
        <PageTitle value={meta.title} onChange={saveTitle} onEnter={focusEditor} />
      </header>
      {initial.page.kind === 'database'
        ? <Text c="dimmed" px="md">資料庫表格視圖將在下一個里程碑加入。</Text>
        : <BlockEditor pageId={pageId} initialContent={initialContent} onReady={onReady} onChange={onChange} onCompositionSettled={onCompositionSettled} fullWidth={meta.fullWidth} />}
    </div>
  </div>;
}
