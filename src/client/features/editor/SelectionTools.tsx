import { useCallback, useEffect, useRef, useState } from 'react';
import { FormattingToolbarController } from '@blocknote/react';
import { FormattingToolbarExtension } from '@blocknote/core/extensions';
import { Alert, Badge, Button, Drawer, Group, Popover, Stack, Text, Textarea } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type { Annotation, ChangeAnnotation, CreateAnnotation } from '@shared/annotations';
import { REACTION_EMOJIS } from '@shared/annotations';
import { api, errorText } from '../../api/client.ts';
import { useMe } from '../../api/auth.ts';
import { IconPicker } from '../page/PageHeader.tsx';
import { markAnnotation } from './annotationStyle.ts';
import type { AppEditor } from './schema.ts';
import { SelectionToolbar } from './SelectionToolbar.tsx';

type Bookmark = ReturnType<AppEditor['prosemirrorState']['selection']['getBookmark']>;
interface Pending { quote: string; blockIds: string[]; mode: 'comment' | 'reaction' }

export function SelectionTools({ editor, pageId }: { editor: AppEditor; pageId: string }) {
  const client = useQueryClient();
  const me = useMe();
  const path = `/api/pages/${pageId}/annotations`;
  const queryKey = ['annotations', me.data?.id, pageId];
  const annotations = useQuery({ queryKey, queryFn: ({ signal }) => api<{ annotations: Annotation[] }>('GET', path, { signal }), enabled: !!me.data, refetchInterval: 15_000 });
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const bookmark = useRef<Bookmark | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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
    const existing = annotations.data?.annotations.find(item => !item.resolved && item.quote === quote && commonIds?.has(item.id));
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
      const id = mark.dataset.annotationIds?.split(' ').find(value => annotations.data?.annotations.some(item => item.id === value));
      if (id) { setPending(null); setSelectedId(id); setFailure(null); setDraft(''); setOpened(true); }
    };
    const context = (event: MouseEvent) => {
      if (event.shiftKey || editor.prosemirrorView.composing || editor.prosemirrorState.selection.empty
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
  }, [editor, annotations.data]);

  const mutation = useMutation({
    onMutate: () => client.cancelQueries({ queryKey }),
    mutationFn: async ({ create, change }: { create?: CreateAnnotation; change?: { annotation: Annotation; input: ChangeAnnotation } }) => {
      if (create) return api<{ annotation: Annotation }>('POST', path, { json: create });
      if (!change) throw new Error('請選擇討論。');
      return api<{ annotation: Annotation }>('PATCH', `${path}/${change.annotation.id}`, { json: change.input, headers: { 'If-Match': `"${change.annotation.version}"` } });
    },
    onSuccess: ({ annotation }, variables) => {
      client.setQueryData<{ annotations: Annotation[] }>(queryKey, current => ({ annotations: [...(current?.annotations.filter(item => item.id !== annotation.id) ?? []), annotation] }));
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
  const active = annotations.data?.annotations.filter(item => showResolved || !item.resolved) ?? [];
  return <>
    <FormattingToolbarController formattingToolbar={toolbar} />
    <div className="selection-discussions"><Button variant="subtle" color="gray" size="compact-xs" leftSection={<MessageSquare size={14} />} onClick={() => { setPending(null); setSelectedId(null); setOpened(true); }}>留言與反應 {annotations.data?.annotations.filter(item => !item.resolved).length || ''}</Button></div>
    <Drawer opened={opened} onClose={close} title="留言與表情反應" position="right" size="sm" keepMounted={false} closeOnClickOutside={false} closeButtonProps={{ 'aria-label': '關閉留言' }}>
      <Stack gap="sm">
        {annotations.isError && <Alert color="red">{errorText(annotations.error)}<Button variant="subtle" onClick={() => { void annotations.refetch(); }}>重新載入</Button></Alert>}
        {failure && <Alert color="red" role="alert">{failure}</Alert>}
        {!pending && <Group><Button size="compact-xs" variant="subtle" onClick={() => { if (draft.trim() && !window.confirm('放棄尚未送出的留言？')) return; setDraft(''); setSelectedId(null); setShowResolved(value => !value); }}>{showResolved ? '只顯示未解決' : '包含已解決'}</Button></Group>}
        {!pending && !selected && <>
          {annotations.isPending && <Text c="dimmed">載入中…</Text>}
          {!annotations.isPending && active.length === 0 && <Text c="dimmed">選取內文後，使用選取工具加入留言或表情反應。</Text>}
          {active.map(item => <Button key={item.id} variant="default" className="annotation-list-item" onClick={() => { setSelectedId(item.id); setDraft(''); setFailure(null); }}><span><q>{item.quote}</q><span>{item.messages.length} 則留言 {item.reactions.join(' ')} {item.resolved ? ' · 已解決' : ''}</span></span></Button>)}
        </>}
        {(pending || selected) && <>
          <blockquote className="annotation-quote">{pending?.quote ?? selected?.quote}</blockquote>
          <Text size="xs" c="dimmed">原文摘要；點擊內文的標記可重新開啟。若原文已移除，討論仍保留於此。</Text>
          {selected && <>
            <Group justify="space-between"><Button size="compact-xs" variant="subtle" disabled={mutation.isPending} onClick={() => { if (draft.trim() && !window.confirm('放棄尚未送出的留言？')) return; setDraft(''); setSelectedId(null); }}>所有討論</Button>
              <Button size="compact-xs" variant="subtle" disabled={mutation.isPending} onClick={() => mutation.mutate({ change: { annotation: selected, input: { action: 'resolve', resolved: !selected.resolved } } })}>{selected.resolved ? '重新開啟討論' : '標示為已解決'}</Button></Group>
            {selected.resolved && <Badge color="gray">已解決</Badge>}
            {selected.messages.map(message => <div className="annotation-message" key={message.id}><Text size="xs" c="dimmed">{new Date(message.createdAt).toLocaleString('zh-TW')}</Text><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</Text></div>)}
            {selected.reactions.length > 0 && <Group gap={4}>{selected.reactions.map(emoji => <Button key={emoji} size="compact-sm" variant="light" aria-label={`移除反應 ${emoji}`} disabled={mutation.isPending} onClick={() => react(emoji)}>{emoji}</Button>)}</Group>}
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
