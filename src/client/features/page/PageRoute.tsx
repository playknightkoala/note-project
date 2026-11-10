import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { Alert, Button, Center, Group, Loader, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker, useParams } from 'react-router';
import { pageKeys, usePage, usePatchPage } from '../../api/pages.ts';
import { errorText, isApiError } from '../../api/client.ts';
import { loadNote, offlineNote, syncNotes } from '../../offline/notes.ts';
import type { LocalPageResponse } from '../../offline/notes.ts';
import { exportPageDraft } from '../../offline/exportDraft.ts';
import { useOnline } from '../../offline/useOnline.ts';
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
    return <Center h="60vh"><Text c="dimmed">{isApiError(page.error, 404) ? '找不到這個頁面，可能已被刪除。' : errorText(page.error)}</Text></Center>;
  }
  return <PageView key={pageId} initial={page.data} />;
}

function PageView({ initial }: { initial: LocalPageResponse }) {
  const pageId = initial.page.id;
  const online = useOnline();
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
    pageId, initialVersion: initial.page.version, initialLocalRevision: initial.localRevision,
    getContent: force => !editorRef.current || (composingRef.current() && !force) ? null : editorRef.current.document as unknown[],
    onRemoteUpdate: () => {
      const revision = localRevisionRef.current;
      setRefreshError(null);
      void queryClient.fetchQuery({ queryKey: pageKeys.page(pageId), staleTime: 0, networkMode: 'always', queryFn: () => loadNote(pageId) })
        .then(fresh => {
          // Typing while this GET was pending must keep the local draft and its old If-Match.
          if (localRevisionRef.current !== revision) return;
          replaceContent(fresh.page.content);
          setMeta({ title: fresh.page.title, icon: fresh.page.icon, fullWidth: fresh.page.fullWidth, coverUrl: fresh.page.coverUrl, coverPosition: fresh.page.coverPosition });
          autosave.setVersion(fresh.page.version, fresh.localRevision);
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
  const onComposingChange = useCallback(() => { if (replacingRef.current) return; localRevisionRef.current++; autosave.markComposing(); }, [autosave]);
  const [actionError, setActionError] = useState<string | null>(null);

  // A conflict blocks saving. Before the page is left, an ordinary note stores its draft on this device; where that
  // is not possible (rows, or a newer draft from another tab) the user decides whether to give the edits up.
  const autosaveRef = useRef(autosave); autosaveRef.current = autosave;
  const blocker = useBlocker(useCallback(() => autosaveRef.current.unsavedConflict(), []));
  const blockerRef = useRef(blocker); blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let active = true;
    void autosaveRef.current.keepDraft(true).then(kept => {
      if (!active || blockerRef.current.state !== 'blocked') return;
      if (kept || window.confirm('這裡的修改與線上版本衝突，尚未保存。離開這個頁面會遺失這些修改（可先按「匯出此處草稿」）。確定離開？')) blockerRef.current.proceed();
      else blockerRef.current.reset();
    });
    return () => { active = false; };
  }, [blocker.state]);

  /** Everything typed here must be on the server before a history restore replaces the content. */
  const prepareRestore = useCallback(async (): Promise<number> => {
    await autosave.settle();
    if (initial.page.kind === 'page') {
      await syncNotes({ force: true });
      const note = await offlineNote(pageId).catch(() => undefined);
      if (note?.pending) throw new Error('這裡還有尚未同步到伺服器的修改。請先完成同步或處理衝突，再還原歷史版本。');
      if (note) return note.base.page.version;
    }
    if (autosave.hasUnsaved()) throw new Error('這裡還有尚未儲存的修改，請先完成儲存再還原歷史版本。');
    return autosave.version();
  }, [autosave, initial.page.kind, pageId]);
  const saveTitle = useCallback((title: string) => { localRevisionRef.current++; setMeta(m => ({ ...m, title })); patch.mutate({ id: pageId, title, localRevision: autosave.localRevision() }); }, [patch, pageId, autosave]);
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
      prepare={prepareRestore} onRestored={() => { void autosave.resolveConflict('reload'); }} />
    {autosave.state.status === 'conflict' && <Alert color="red" variant="light" className="conflict-bar" title="此頁面已在其他地方更新">
      <Group gap="sm">
        <Text size="sm">本機草稿已保留，系統不會自動合併或覆蓋。建議先匯出草稿，再選擇載入最新版本（捨棄這裡的修改），或以這裡的內容覆蓋（被覆蓋的線上版本會留在頁面歷史）。</Text>
        <Button size="xs" variant="subtle" onClick={() => {
          const content = composingRef.current() ? null : editorRef.current?.document;
          if (content) exportPageDraft({ ...initial, page: { ...initial.page, title: meta.title, content } });
        }}>匯出此處草稿</Button>
        <Button size="xs" onClick={() => { if (window.confirm('載入最新版本會捨棄這裡的修改。請先確認已匯出需要保留的草稿，確定繼續？')) void autosave.resolveConflict('reload'); }}>載入最新版本</Button>
        <Button size="xs" variant="default" onClick={() => { if (window.confirm('以這裡的內容覆蓋線上版本？被覆蓋的內容會保存在頁面歷史。')) void autosave.resolveConflict('overwrite'); }}>以我的內容覆蓋</Button>
      </Group>
    </Alert>}
    {refreshError && <Alert color="red" title="無法載入最新內容">{refreshError}</Alert>}
    {actionError && <Alert color="red" withCloseButton onClose={() => setActionError(null)}>{actionError}</Alert>}
    {patch.error && <Alert color="red" title="頁面設定尚未儲存">{errorText(patch.error)}</Alert>}
    <div ref={bodyRef} className={`page-body${initial.page.kind === 'database' ? ' page-body--database' : ''}${meta.fullWidth ? ' page-body--full' : ''}${smallText ? ' page-body--small' : ''}`}>
      <PageHeader title={meta.title} icon={meta.icon} coverUrl={meta.coverUrl} coverPosition={meta.coverPosition}
        onTitle={saveTitle} onIcon={saveIcon} onCover={saveCover} onCoverPosition={saveCoverPosition} onEnter={focusEditor} />
      {initial.page.kind === 'database'
        ? online ? <DatabaseView databaseId={pageId} /> : <Alert title="資料庫需要連線">一般筆記仍可離線編輯，資料庫視圖請恢復連線後開啟。</Alert>
        : <>
          {initial.page.kind === 'row' && initial.page.databaseId && (online ? <RowPropertiesPanel rowId={pageId} databaseId={initial.page.databaseId} /> : <Alert title="資料列需要連線">已下載的內文可閱讀，編輯請恢復連線後進行。</Alert>)}
          <BlockEditor pageId={pageId} initialContent={initialContent} onReady={onReady} onChange={onChange} onCompositionSettled={onCompositionSettled} onComposingChange={onComposingChange} onError={setActionError} fullWidth={meta.fullWidth} uploadFile={upload} editable={online || initial.page.kind === 'page'} annotationsEnabled={online && autosave.state.version > 0} />
        </>}
    </div>
  </div>}
  </ContextMenu>;
}
