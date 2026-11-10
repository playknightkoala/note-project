import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DesktopFormattingToolbarController } from '@blocknote/react';
import { FormattingToolbarExtension } from '@blocknote/core/extensions';
import { Alert, Badge, Button, Drawer, Group, Popover, Stack, Text, Textarea } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useMediaQuery } from '@mantine/hooks';
import type { Annotation, ChangeAnnotation, CreateAnnotation } from '@shared/annotations';
import type { OfflineOp } from '@shared/offline';
import { newId } from '@shared/ids';
import { isActiveAnnotation, REACTION_EMOJIS } from '@shared/annotations';
import { applyAnnotationOp } from '@shared/offline';
import { api, errorText } from '../../api/client.ts';
import { useMe } from '../../api/auth.ts';
import { IconPicker } from '../page/PageHeader.tsx';
import { markAnnotation, removeAnnotation, updateAnnotationHighlights } from './annotationStyle.ts';
import { readLocal, updateLocal } from '../../offline/storage.ts';
import { hasQueued, localAnnotations, OUTBOX_EVENT, rememberAnnotations, submitOp, transient } from '../../offline/outbox.ts';
import type { AppEditor } from './schema.ts';
import { SelectionToolbar } from './SelectionToolbar.tsx';
import { MobileSelectionTools } from './MobileSelectionTools.tsx';
import { useUpdateGuard } from '../../updates/guards.ts';

type Bookmark = ReturnType<AppEditor['prosemirrorState']['selection']['getBookmark']>;
/** `local`: read from this device (offline, or while changes to this page's discussions wait to be synced). */
interface Discussions { annotations: Annotation[]; local?: boolean }
async function loadDiscussions(pageId: string, signal: AbortSignal): Promise<Discussions> {
  if (!await hasQueued(`ann:${pageId}`)) {
    try {
      const loaded = await api<Discussions>('GET', `/api/pages/${pageId}/annotations`, { signal });
      // What was just shown is what a change made right after a dropped connection has to be applied to.
      void rememberAnnotations(pageId, loaded.annotations);
      return loaded;
    } catch (error) { if (!transient(error) || signal.aborted) throw error; }
  }
  return { annotations: await localAnnotations(pageId), local: true };
}
interface Pending { quote: string; blockIds: string[]; mode: 'comment' | 'reaction' }

export function SelectionTools({ editor, pageId, composing = false, annotationsEnabled = true }: { editor: AppEditor; pageId: string; composing?: boolean; annotationsEnabled?: boolean }) {
  const mobile = useMediaQuery('(max-width: 767px), (pointer: coarse)', undefined, { getInitialValueInEffect: false });
  const client = useQueryClient();
  const me = useMe();
  const queryKey = useMemo(() => ['annotations', me.data?.id, pageId], [me.data?.id, pageId]);
  const annotations = useQuery({ queryKey, queryFn: ({ signal }) => loadDiscussions(pageId, signal), enabled: !!me.data && annotationsEnabled, refetchInterval: 15_000, networkMode: 'always', retry: false });
  useEffect(() => {
    const refresh = () => { void client.invalidateQueries({ queryKey }); };
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === `ann:${pageId}`) refresh(); };
    window.addEventListener(OUTBOX_EVENT, changed); window.addEventListener('online', refresh);
    return () => { window.removeEventListener(OUTBOX_EVENT, changed); window.removeEventListener('online', refresh); };
  }, [client, queryKey, pageId]);
  const highlightKey = me.data ? `annotation-highlights:${me.data.id}:${pageId}` : null;
  const [cachedHighlights, setCachedHighlights] = useState<{ key: string; ids: string[] } | null>(null);
  const highlightIds = useMemo(() => annotations.data
    ? annotations.data.annotations.filter(isActiveAnnotation).map(item => item.id)
    : cachedHighlights?.key === highlightKey ? cachedHighlights.ids : undefined, [annotations.data, cachedHighlights, highlightKey]);
  // A small, account-isolated snapshot keeps resolved/deleted markers hidden after an offline reload.
  useEffect(() => {
    if (!highlightKey) return;
    let active = true;
    void readLocal<string[]>(highlightKey).then(ids => { if (active && ids) setCachedHighlights({ key: highlightKey, ids }); }).catch(() => {});
    return () => { active = false; };
  }, [highlightKey]);
  useEffect(() => {
    if (!highlightKey || !annotations.data) return;
    const ids = annotations.data.annotations.filter(isActiveAnnotation).map(item => item.id);
    void updateLocal<string[]>(highlightKey, () => ids).catch(() => {});
  }, [highlightKey, annotations.data]);
  useEffect(() => {
    updateAnnotationHighlights(editor, highlightIds ? new Set(highlightIds) : undefined);
  }, [editor, highlightIds]);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const bookmark = useRef<Bookmark | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useUpdateGuard(() => { if (draft.trim()) throw new Error('請先送出或取消尚未送出的留言，再更新。'); });
  const [failure, setFailure] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = annotations.data?.annotations.find(item => item.id === selectedId);

  // A saved selection is mapped through edits, including remote content replacements.
  useEffect(() => editor.onBeforeChange(({ tr }) => { if (bookmark.current) bookmark.current = bookmark.current.map(tr.mapping); }), [editor]);
  const begin = useCallback((mode: Pending['mode']) => {
    const { selection, doc } = editor.prosemirrorState;
    const quote = doc.textBetween(selection.from, selection.to, '\n').trim();
    if (!quote) return;
    let commonIds: Set<string> | undefined;
    doc.nodesBetween(selection.from, selection.to, node => {
      if (!node.isText) return;
      const ids = String(node.marks.find(mark => mark.type.name === 'annotation')?.attrs.stringValue ?? '').split(' ');
      commonIds = new Set(commonIds ? [...commonIds].filter(id => ids.includes(id)) : ids);
    });
    const existing = annotations.data?.annotations.find(item => isActiveAnnotation(item) && item.quote === quote && commonIds?.has(item.id));
    if (existing) {
      bookmark.current = null; setPending(null); setSelectedId(existing.id);
    } else {
      bookmark.current = selection.getBookmark();
      setPending({ quote: quote.slice(0, 8000), blockIds: (editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]).slice(0, 100).map(block => block.id), mode });
      setSelectedId(null);
    }
    setDraft(''); setFailure(null); setOpened(true);
    editor.getExtension(FormattingToolbarExtension)?.store.setState(false);
  }, [editor, annotations.data]);
  const toolbar = useCallback(() => <SelectionToolbar onAnnotate={begin} />, [begin]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      const mark = (event.target as Element).closest<HTMLElement>('[data-annotation-ids]');
      // The native click collapses the DOM selection before ProseMirror updates its state.
      if (!mark || !window.getSelection()?.isCollapsed) return;
      const id = mark.dataset.annotationIds?.split(' ').find(value => annotations.data?.annotations.some(item => item.id === value && isActiveAnnotation(item)));
      if (id) { setPending(null); setSelectedId(id); setFailure(null); setDraft(''); setOpened(true); }
    };
    const context = (event: MouseEvent) => {
      if (mobile || composing || event.shiftKey || editor.prosemirrorView.composing || editor.prosemirrorState.selection.empty
        || (event.target as Element).closest('a, input, textarea, select') || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      event.preventDefault(); event.stopPropagation();
      editor.getExtension(FormattingToolbarExtension)?.store.setState(true);
    };
    let detach = () => {};
    const attach = () => {
      detach();
      const dom = editor.domElement; if (!dom) return;
      dom.addEventListener('click', click, true); dom.addEventListener('contextmenu', context, true);
      detach = () => { dom.removeEventListener('click', click, true); dom.removeEventListener('contextmenu', context, true); };
    };
    const stop = editor.onMount(attach); attach();
    return () => { stop(); detach(); };
  }, [editor, annotations.data, mobile, composing]);

  const mutation = useMutation({
    networkMode: 'always',
    onMutate: () => client.cancelQueries({ queryKey }),
    mutationFn: async ({ create, change, remove }: { create?: CreateAnnotation; change?: { annotation: Annotation; input: ChangeAnnotation }; remove?: Annotation }): Promise<{ annotation?: Annotation; deletedId?: string }> => {
      if (!annotationsEnabled) throw new Error('此頁面目前無法加入留言與反應。');
      // Every change is a small operation with ids chosen here: sent now when possible, otherwise kept on this
      // device and sent at the next sync, where a repeat cannot add a second copy.
      const target = { pageId, annotationId: remove?.id ?? change?.annotation.id ?? newId() };
      let op: OfflineOp;
      if (remove) op = { type: 'annotation.delete', ...target, messages: remove.messages.length };
      else if (create) op = { type: 'annotation.create', ...target, messageId: newId(), quote: create.quote, blockIds: create.blockIds, ...(create.text ? { text: create.text } : {}), ...(create.emoji ? { emoji: create.emoji } : {}), at: Date.now() };
      else if (!change) throw new Error('請選擇討論。');
      else if (change.input.action === 'comment') op = { type: 'annotation.comment', ...target, messageId: newId(), text: change.input.text, at: Date.now() };
      else if (change.input.action === 'reaction') op = { type: 'annotation.reaction', ...target, emoji: change.input.emoji, on: !change.annotation.reactions.includes(change.input.emoji) };
      else op = { type: 'annotation.resolve', ...target, resolved: change.input.resolved };
      const result = await submitOp(op);
      if (remove) return { deletedId: remove.id };
      if (result.annotation) return { annotation: result.annotation };
      // Stored on this device, but its discussion is not in the copy kept here: show the change on what is displayed.
      const shown = result.queued ? applyAnnotationOp(change ? [change.annotation] : [], op).find(item => item.id === target.annotationId) : undefined;
      if (!shown) throw new Error('這則討論已不存在，請重新載入。');
      return { annotation: shown };
    },
    onSuccess: ({ annotation, deletedId }, variables) => {
      if (deletedId) {
        client.setQueryData<Discussions>(queryKey, current => ({ ...current, annotations: current?.annotations.filter(item => item.id !== deletedId) ?? [] }));
        removeAnnotation(editor, deletedId);
        setSelectedId(null); setDraft(''); setFailure(null); setPickerOpen(false);
        return;
      }
      if (!annotation) return;
      client.setQueryData<Discussions>(queryKey, current => ({ ...current, annotations: [...(current?.annotations.filter(item => item.id !== annotation.id) ?? []), annotation] }));
      if (variables.create && bookmark.current) {
        const selection = bookmark.current.resolve(editor.prosemirrorState.doc);
        if (!selection.empty) markAnnotation(editor, selection.from, selection.to, annotation.id);
        bookmark.current = null;
      }
      editor.getExtension(FormattingToolbarExtension)?.store.setState(false);
      setPending(null); setSelectedId(annotation.id);
      if (variables.create || variables.change?.input.action === 'comment') setDraft('');
      setFailure(null); setPickerOpen(false);
    },
    onError: error => { setFailure(errorText(error)); void annotations.refetch(); },
  });
  const saveComment = () => {
    if (!draft.trim() || mutation.isPending) return;
    if (pending) mutation.mutate({ create: { quote: pending.quote, blockIds: pending.blockIds, text: draft } });
    else if (selected) mutation.mutate({ change: { annotation: selected, input: { action: 'comment', text: draft } } });
  };
  const react = (emoji: string) => {
    if (mutation.isPending) return;
    if (pending) mutation.mutate({ create: { quote: pending.quote, blockIds: pending.blockIds, emoji, ...(draft.trim() ? { text: draft } : {}) } });
    else if (selected) mutation.mutate({ change: { annotation: selected, input: { action: 'reaction', emoji } } });
  };
  const close = () => {
    if (mutation.isPending) return;
    if (draft.trim() && !window.confirm('放棄尚未送出的留言？')) return;
    setOpened(false); setPending(null); bookmark.current = null; setDraft(''); setFailure(null); setPickerOpen(false);
  };
  const active = annotations.data?.annotations.filter(item => showResolved || isActiveAnnotation(item)) ?? [];
  return <>
    {mobile ? <MobileSelectionTools editor={editor} composing={composing} suspended={opened} onAnnotate={begin} /> : !composing && !opened && <DesktopFormattingToolbarController formattingToolbar={toolbar} />}
    <div className="selection-discussions"><Button variant="subtle" color="gray" size="compact-xs" leftSection={<MessageSquare size={14} />} onClick={() => { setPending(null); setSelectedId(null); setOpened(true); }}>留言與反應 {annotations.data?.annotations.filter(isActiveAnnotation).length || ''}</Button></div>
    <Drawer opened={opened} onClose={close} title="留言與表情反應" position="right" size="sm" keepMounted={false} closeOnClickOutside={false} closeButtonProps={{ 'aria-label': '關閉留言' }}>
      {!annotationsEnabled && <Alert color="orange">此頁面目前無法加入留言與反應。</Alert>}
      {annotations.data?.local && <Text size="xs" c="orange" role="status" mb="xs">目前顯示此裝置上的留言；新增與修改已存此裝置，連線後自動同步。</Text>}
      <Stack gap="sm">
        {annotations.isError && <Alert color="red">{errorText(annotations.error)}<Button variant="subtle" onClick={() => { void annotations.refetch(); }}>重新載入</Button></Alert>}
        {failure && <Alert color="red" role="alert">{failure}</Alert>}
        {!pending && <Group><Button size="compact-xs" variant="subtle" onClick={() => { if (draft.trim() && !window.confirm('放棄尚未送出的留言？')) return; setDraft(''); setSelectedId(null); setShowResolved(value => !value); }}>{showResolved ? '只顯示未解決' : '包含已解決／已取消'}</Button></Group>}
        {!pending && !selected && <>
          {annotations.isPending && <Text c="dimmed">載入中…</Text>}
          {!annotations.isPending && active.length === 0 && <Text c="dimmed">選取內文後，使用選取工具加入留言或表情反應。</Text>}
          {active.map(item => <Button key={item.id} variant="default" className="annotation-list-item" onClick={() => { setSelectedId(item.id); setDraft(''); setFailure(null); }}><span><q>{item.quote}</q><span>{item.messages.length} 則留言 {item.reactions.join(' ')} {item.resolved ? ' · 已解決' : !isActiveAnnotation(item) ? ' · 已取消' : ''}</span></span></Button>)}
        </>}
        {(pending || selected) && <>
          <blockquote className="annotation-quote">{pending?.quote ?? selected?.quote}</blockquote>
          <Text size="xs" c="dimmed">原文摘要；點擊黃色標記可查看討論。已解決或已取消的項目可從「包含已解決／已取消」查看。若原文已移除，討論仍保留於此。</Text>
          {selected && <>
            <Group justify="space-between"><Button size="compact-xs" variant="subtle" disabled={mutation.isPending} onClick={() => { if (draft.trim() && !window.confirm('放棄尚未送出的留言？')) return; setDraft(''); setSelectedId(null); }}>所有討論</Button>
              <Button size="compact-xs" variant="subtle" disabled={mutation.isPending} onClick={() => mutation.mutate({ change: { annotation: selected, input: { action: 'resolve', resolved: !selected.resolved } } })}>{selected.resolved ? '重新開啟討論' : '標示為已解決'}</Button></Group>
            {selected.resolved && <Badge color="gray">已解決</Badge>}
            {!selected.resolved && !isActiveAnnotation(selected) && <Badge color="gray">已取消</Badge>}
            {selected.messages.map(message => <div className="annotation-message" key={message.id}><Text size="xs" c="dimmed">{new Date(message.createdAt).toLocaleString('zh-TW')}</Text><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</Text></div>)}
            {selected.reactions.length > 0 && <Group gap={4}>{selected.reactions.map(emoji => <Button key={emoji} size="compact-sm" variant="light" aria-label={`移除反應 ${emoji}`} disabled={mutation.isPending} onClick={() => react(emoji)}>{emoji}</Button>)}</Group>}
            <Button size="compact-xs" variant="subtle" color="red" disabled={mutation.isPending || !annotationsEnabled} onClick={() => {
              if (window.confirm('刪除整則討論及其中所有留言、表情反應？尚未送出的留言也會捨棄。筆記文字會保留，此操作無法復原。')) mutation.mutate({ remove: selected });
            }}>刪除整則討論</Button>
          </>}
          <Group gap={4} aria-label="常用表情反應">{REACTION_EMOJIS.map(emoji => <Button key={emoji} aria-label={`反應 ${emoji}`} size="compact-sm" variant="subtle" disabled={mutation.isPending} onClick={() => react(emoji)}>{emoji}</Button>)}</Group>
          <Popover opened={pickerOpen} onChange={setPickerOpen} withinPortal={false} position="bottom-start"><Popover.Target><Button size="compact-xs" variant="subtle" disabled={mutation.isPending} onClick={() => setPickerOpen(value => !value)}>更多表情符號…</Button></Popover.Target><Popover.Dropdown p={0}><IconPicker onPick={react} /></Popover.Dropdown></Popover>
          <Textarea label={selected ? '回覆留言' : '留言'} placeholder="輸入留言…" value={draft} maxLength={4000} autosize minRows={3} disabled={mutation.isPending} onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); saveComment(); } }} />
          <Button onClick={saveComment} loading={mutation.isPending} disabled={!draft.trim()}>送出留言</Button>
        </>}
      </Stack>
    </Drawer>
  </>;
}
