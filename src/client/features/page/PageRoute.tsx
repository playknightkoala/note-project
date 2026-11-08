import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { Alert, Button, Center, Group, Loader, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { PageResponse } from '@shared/api';
import { pageKeys, usePage, usePatchPage } from '../../api/pages.ts';
import { api, errorText, isApiError } from '../../api/client.ts';
import { useUiState } from '../../app/uiState.tsx';
import { BlockEditor } from '../editor/BlockEditor.tsx';
import type { AppEditor } from '../editor/schema.ts';
import type { schema } from '../editor/schema.ts';
import { TopBar } from '../shell/TopBar.tsx';
import { PageHeader } from './PageHeader.tsx';
import { uploadFile } from '../../api/files.ts';
import { useAutosave } from './useAutosave.ts';
import { useTableBleed } from './useTableBleed.ts';
import { HistoryDrawer } from './HistoryDrawer.tsx';
import { DatabaseView } from '../database/DatabaseView.tsx';
import { RowPropertiesPanel } from '../database/RowPropertiesPanel.tsx';
import { ContextMenu } from '../shell/ContextMenu.tsx';
import { PageMenuItems } from '../shell/PageMenuItems.tsx';

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
  const replacingRef = useRef(false);
  const remoteContentRef = useRef<string | null>(null);
  const localRevisionRef = useRef(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [smallText, setSmallText] = useState(() => { try { return localStorage.getItem('notes:small-text') === '1'; } catch { return false; } });
  const toggleSmallText = () => setSmallText(value => { try { localStorage.setItem('notes:small-text', value ? '0' : '1'); } catch { /* ignore */ } return !value; });
  const composingRef = useRef<() => boolean>(() => false);
  const pageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useTableBleed(pageRef, bodyRef);
  const [meta, setMeta] = useState({ title: initial.page.title, icon: initial.page.icon, fullWidth: initial.page.fullWidth, coverUrl: initial.page.coverUrl, coverPosition: initial.page.coverPosition });
  useEffect(() => { rememberPage(pageId); expandMany(initial.breadcrumbs.slice(0, -1).map(b => b.id)); }, [pageId, rememberPage, expandMany, initial.breadcrumbs]);

  const replaceContent = useCallback((content: unknown[]) => {
    const editor = editorRef.current; if (!editor) return;
    const stop = editor.onBeforeChange(({ tr }) => { tr.setMeta('addToHistory', false); });
    replacingRef.current = true;
    try {
      editor.replaceBlocks(editor.document, content as Blocks);
      remoteContentRef.current = JSON.stringify(editor.document);
    } finally { replacingRef.current = false; stop(); }
  }, []);

  const autosave = useAutosave({
    pageId, initialVersion: initial.page.version,
    getContent: () => (composingRef.current() || !editorRef.current) ? null : editorRef.current.document as unknown[],
    onRemoteUpdate: () => {
      const revision = localRevisionRef.current;
      setRefreshError(null);
      void queryClient.fetchQuery({ queryKey: pageKeys.page(pageId), staleTime: 0, queryFn: () => api<PageResponse>('GET', `/api/pages/${pageId}`) })
        .then(fresh => {
          // Typing while this GET was pending must keep the local draft and its old If-Match.
          if (localRevisionRef.current !== revision) return;
          replaceContent(fresh.page.content);
          setMeta({ title: fresh.page.title, icon: fresh.page.icon, fullWidth: fresh.page.fullWidth, coverUrl: fresh.page.coverUrl, coverPosition: fresh.page.coverPosition });
          autosave.setVersion(fresh.page.version);
        }).catch(error => setRefreshError(errorText(error)));
    },
  });

  const onReady = useCallback((editor: AppEditor, isComposing: () => boolean) => { editorRef.current = editor; composingRef.current = isComposing; }, []);
  const onChange = useCallback(() => {
    if (replacingRef.current || (remoteContentRef.current !== null && JSON.stringify(editorRef.current?.document) === remoteContentRef.current)) return;
    remoteContentRef.current = null;
    localRevisionRef.current++;
    autosave.markDirty();
  }, [autosave]);
  const onCompositionSettled = useCallback(() => { localRevisionRef.current++; autosave.markDirty(); }, [autosave]);
  const saveTitle = useCallback((title: string) => { setMeta(m => ({ ...m, title })); patch.mutate({ id: pageId, title }); }, [patch, pageId]);
  const saveIcon = useCallback((icon: string | null) => { setMeta(m => ({ ...m, icon })); patch.mutate({ id: pageId, icon }); }, [patch, pageId]);
  const saveCover = useCallback((cover: string | null) => {
    if (cover === null) { setMeta(m => ({ ...m, coverUrl: null })); patch.mutate({ id: pageId, coverFileId: null, coverPreset: null }); return; }
    if (cover.startsWith('gradient:')) { setMeta(m => ({ ...m, coverUrl: cover })); patch.mutate({ id: pageId, coverPreset: cover }); return; }
    patch.mutate({ id: pageId, coverFileId: cover, coverPosition: 50 }, { onSuccess: response => setMeta(m => ({ ...m, coverUrl: response.page.coverUrl, coverPosition: 50 })) });
  }, [patch, pageId]);
  const saveCoverPosition = useCallback((coverPosition: number) => { setMeta(m => ({ ...m, coverPosition })); patch.mutate({ id: pageId, coverPosition }); }, [patch, pageId]);
  const upload = useCallback(async (file: File) => (await uploadFile(file)).url, []);
  const focusEditor = useCallback(() => {
    const editor = editorRef.current; if (!editor) return;
    const first = editor.document[0]; if (first) editor.setTextCursorPosition(first, 'start');
    editor.focus();
  }, []);
  const initialContent = useMemo(() => initial.page.content as Blocks, [initial.page.content]);
  const currentPage = { id: pageId, kind: initial.page.kind, title: meta.title, icon: meta.icon, fullWidth: meta.fullWidth };
  const toggleFullWidth = () => { const fullWidth = !meta.fullWidth; setMeta(m => ({ ...m, fullWidth })); patch.mutate({ id: pageId, fullWidth }); };

  return <ContextMenu label="頁面右鍵選單" items={<PageMenuItems page={currentPage} onToggleFullWidth={toggleFullWidth} smallText={smallText} onToggleSmallText={toggleSmallText} onOpenHistory={() => setHistoryOpen(true)} />}>
    {handlers => <div className="page" ref={pageRef} {...handlers}>
    <TopBar page={currentPage} breadcrumbs={initial.breadcrumbs}
      saveStatus={autosave.state.status} saveError={autosave.state.error} onRetry={() => { void autosave.saveNow(); }}
      onToggleFullWidth={toggleFullWidth}
      smallText={smallText} onToggleSmallText={toggleSmallText} onOpenHistory={() => setHistoryOpen(true)} />
    <HistoryDrawer pageId={pageId} opened={historyOpen} onClose={() => setHistoryOpen(false)} currentVersion={autosave.state.version}
      onRestored={() => { void autosave.resolveConflict('reload'); }} />
    {autosave.state.status === 'conflict' && <Alert color="red" variant="light" className="conflict-bar" title="此頁面已在其他地方更新">
      <Group gap="sm">
        <Text size="sm">你可以載入最新版本（會捨棄這裡尚未儲存的修改），或以這裡的內容覆蓋（被覆蓋的版本會留在頁面歷史）。</Text>
        <Button size="xs" onClick={() => { void autosave.resolveConflict('reload'); }}>載入最新版本</Button>
        <Button size="xs" variant="default" onClick={() => { void autosave.resolveConflict('overwrite'); }}>以我的內容覆蓋</Button>
      </Group>
    </Alert>}
    {refreshError && <Alert color="red" title="無法載入最新內容">{refreshError}</Alert>}
    <div ref={bodyRef} className={`page-body${meta.fullWidth ? ' page-body--full' : ''}${smallText ? ' page-body--small' : ''}`}>
      <PageHeader title={meta.title} icon={meta.icon} coverUrl={meta.coverUrl} coverPosition={meta.coverPosition}
        onTitle={saveTitle} onIcon={saveIcon} onCover={saveCover} onCoverPosition={saveCoverPosition} onEnter={focusEditor} />
      {initial.page.kind === 'database'
        ? <DatabaseView databaseId={pageId} />
        : <>
          {initial.page.kind === 'row' && initial.page.databaseId && <RowPropertiesPanel rowId={pageId} databaseId={initial.page.databaseId} />}
          <BlockEditor pageId={pageId} initialContent={initialContent} onReady={onReady} onChange={onChange} onCompositionSettled={onCompositionSettled} fullWidth={meta.fullWidth} uploadFile={upload} />
        </>}
    </div>
  </div>}
  </ContextMenu>;
}
