import { useEffect, useRef, useState } from 'react';
import { FormattingToolbar, TableCellMergeButton, useEditorFocus, useEditorState } from '@blocknote/react';
import { Alert, Button, Drawer, Group, Portal, Select, Stack, Text, TextInput } from '@mantine/core';
import { ArrowLeft, Bold, Check, ChevronRight, Code2, Italic, Link, MessageSquare, Palette, RemoveFormatting, SmilePlus, Strikethrough, Type, Underline } from 'lucide-react';
import type { AppEditor } from './schema.ts';
import { selectionBlockTypes } from './SelectionToolbar.tsx';
import { useSavedSelection } from './useSavedSelection.ts';
import { useVisualViewport } from './useVisualViewport.ts';

const styles = [
  { key: 'bold', label: '粗體', icon: Bold }, { key: 'italic', label: '斜體', icon: Italic },
  { key: 'underline', label: '底線', icon: Underline }, { key: 'strike', label: '刪除線', icon: Strikethrough },
  { key: 'code', label: '行內程式碼', icon: Code2 },
] as const;
const colors = [
  { value: 'default', label: '預設' }, { value: '#787774', label: '灰色' }, { value: '#9f6b53', label: '棕色' },
  { value: '#d9730d', label: '橘色' }, { value: '#cb912f', label: '黃色' }, { value: '#448361', label: '綠色' },
  { value: '#337ea9', label: '藍色' }, { value: '#9065b0', label: '紫色' }, { value: '#c14c8a', label: '粉紅色' }, { value: '#d44c47', label: '紅色' },
];
type Panel = 'format' | 'blocks' | 'colors' | 'link';

export function MobileSelectionTools({ editor, composing, suspended, onAnnotate }: {
  editor: AppEditor; composing: boolean; suspended: boolean; onAnnotate: (mode: 'comment' | 'reaction') => void;
}) {
  const focused = useEditorFocus({ includeEditorUI: true }, editor);
  const state = useEditorState({ editor, selector: ({ editor }) => ({ styles: editor.getActiveStyles(), block: editor.getTextCursorPosition().block }) });
  const saved = useSavedSelection(editor);
  const { rect, style } = useVisualViewport();
  const dock = useRef<HTMLDivElement>(null);
  const resume = useRef(false);
  const [opened, setOpened] = useState(false);
  const [panel, setPanel] = useState<Panel>('format');
  const [hasText, setHasText] = useState(false);
  const [file, setFile] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const visible = focused && !opened && !suspended && !composing;

  // The dock gets its own space; keep the caret above it as the keyboard and selection move.
  useEffect(() => {
    if (!visible || composing) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.isFocused() || editor.prosemirrorView.composing) return;
        const caret = editor.prosemirrorView.coordsAtPos(editor.prosemirrorState.selection.head);
        const bottom = rect.top + rect.height - (dock.current?.getBoundingClientRect().height ?? 56) - 12;
        if (caret.bottom > bottom) window.scrollBy({ top: caret.bottom - bottom, behavior: 'instant' });
        else if (caret.top < rect.top + 56) window.scrollBy({ top: caret.top - rect.top - 56, behavior: 'instant' });
      });
    };
    update();
    const stop = editor.onSelectionChange(update);
    return () => { stop(); cancelAnimationFrame(frame); };
  }, [editor, visible, composing, rect.top, rect.height]);

  const open = () => {
    if (composing || editor.prosemirrorView.composing || !editor.isEditable) return;
    resume.current = false; saved.capture(); setHasText(!!editor.getSelectedText().trim());
    setFile(['image', 'video', 'audio', 'file'].includes(editor.getTextCursorPosition().block.type));
    setUrl(editor.getSelectedLinkUrl() ?? ''); setError(''); setPanel('format'); setOpened(true);
    // Native selection controls are left alone until this explicit action. The bookmark survives blur and modal focus.
    editor.blur();
    const selection = window.getSelection();
    if (selection?.anchorNode && editor.domElement?.contains(selection.anchorNode)) selection.removeAllRanges();
  };
  const apply = (operation: () => void) => {
    if (composing || editor.prosemirrorView.composing) return false;
    if (!saved.restore()) { setError('選取內容已變更，請關閉面板後重新選取。'); return false; }
    operation(); setError(''); return true;
  };
  const close = () => {
    resume.current = saved.restore(); setOpened(false); setPanel('format'); setError('');
  };
  const annotate = (mode: 'comment' | 'reaction') => {
    if (!apply(() => onAnnotate(mode))) return;
    resume.current = false; setOpened(false); saved.clear();
  };
  const types = selectionBlockTypes(editor);
  const selectedBlocks = editor.getSelection()?.blocks ?? [state.block];
  const matches = (item: typeof types[number]) => selectedBlocks[0]?.type === item.type && Object.entries(item.props ?? {}).every(([key, value]) => (selectedBlocks[0]?.props as Record<string, unknown>)[key] === value);
  const current = types.find(matches);
  const title = { format: '格式與段落', blocks: '轉換段落類型', colors: '文字與背景顏色', link: '設定連結' }[panel];

  return <>
    {visible && <Portal><div ref={dock} className="mobile-selection-dock" style={style} aria-label="手機編輯工具">
      <Button variant="subtle" color="gray" leftSection={<Type size={18} />} aria-label="開啟格式與段落" aria-haspopup="dialog" disabled={composing}
        onPointerDown={event => { event.preventDefault(); }} onClick={open}>格式與段落</Button>
    </div></Portal>}
    <Drawer opened={opened} onClose={close} position="bottom" size="auto" title={title} returnFocus={false} closeButtonProps={{ 'aria-label': '關閉格式面板' }}
      style={style} classNames={{ inner: 'mobile-format-sheet-inner', content: 'mobile-format-sheet-content', body: 'mobile-format-sheet-body' }}
      onExitTransitionEnd={() => { if (resume.current) { resume.current = false; saved.restore(); saved.clear(); editor.focus(); } }}>
      <Stack gap="sm">
        {panel !== 'format' && <Button variant="subtle" color="gray" leftSection={<ArrowLeft size={16} />} onClick={() => { setPanel('format'); setError(''); }}>返回格式</Button>}
        {error && <Alert color="red" role="alert">{error}</Alert>}
        {file ? <FormattingToolbar /> : <>
          {panel === 'format' && <>
            <Button variant="default" justify="space-between" rightSection={<ChevronRight size={16} />} aria-label="轉換段落類型" onClick={() => setPanel('blocks')}>{current?.name ?? '轉換段落類型'}</Button>
            <Group gap="xs"><TableCellMergeButton />{styles.map(({ key, label, icon: Icon }) => <Button key={key} aria-label={label} aria-pressed={!!state.styles[key]} variant={state.styles[key] ? 'light' : 'default'} leftSection={<Icon size={18} />} onClick={() => apply(() => editor.toggleStyles({ [key]: true }))}>{label}</Button>)}</Group>
            <Group gap="xs"><Button variant="default" leftSection={<Palette size={18} />} onClick={() => setPanel('colors')}>顏色</Button>
              <Button variant="default" leftSection={<Link size={18} />} disabled={!hasText} onClick={() => setPanel('link')}>連結</Button>
              <Button variant="default" leftSection={<RemoveFormatting size={18} />} onClick={() => apply(() => editor.removeStyles({ bold: true, italic: true, underline: true, strike: true, code: true, textColor: 'default', backgroundColor: 'default' }))}>清除文字格式</Button></Group>
            <Group gap="xs"><Button variant="light" leftSection={<MessageSquare size={18} />} disabled={!hasText} onClick={() => annotate('comment')}>留言</Button>
              <Button variant="light" leftSection={<SmilePlus size={18} />} disabled={!hasText} onClick={() => annotate('reaction')}>加表情反應</Button></Group>
            {!hasText && <Text size="xs" c="dimmed">目前操作游標所在段落；選取文字後可加入連結、留言或表情反應。</Text>}
          </>}
          {panel === 'blocks' && <div className="mobile-block-types" aria-label="段落類型">{types.map(item => <Button key={`${item.type}-${item.name}`} variant={matches(item) ? 'light' : 'subtle'} color="gray" justify="flex-start" leftSection={<item.icon size={18} />} rightSection={matches(item) ? <Check size={16} /> : undefined} onClick={() => {
            if (apply(() => {
              const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
              editor.transact(() => { for (const block of blocks) editor.updateBlock(block, { type: item.type, props: item.props } as Parameters<AppEditor['updateBlock']>[1]); });
            })) setPanel('format');
          }}>{item.name}</Button>)}</div>}
          {panel === 'colors' && <>
            <Select label="文字顏色" data={colors} value={typeof state.styles.textColor === 'string' ? state.styles.textColor : 'default'} allowDeselect={false} comboboxProps={{ withinPortal: false }} onChange={color => { if (color) apply(() => color === 'default' ? editor.removeStyles({ textColor: 'default' }) : editor.addStyles({ textColor: color })); }} />
            <Select label="背景顏色" data={colors} value={typeof state.styles.backgroundColor === 'string' ? state.styles.backgroundColor : 'default'} allowDeselect={false} comboboxProps={{ withinPortal: false }} onChange={color => { if (color) apply(() => color === 'default' ? editor.removeStyles({ backgroundColor: 'default' }) : editor.addStyles({ backgroundColor: color })); }} />
          </>}
          {panel === 'link' && <><TextInput label="連結網址" placeholder="https://…" value={url} maxLength={2000} onChange={event => setUrl(event.currentTarget.value)} />
            <Button onClick={() => {
              const link = url.trim();
              if (!/^(https?:\/\/|mailto:|tel:)/i.test(link)) { setError('請輸入 http、https、mailto 或 tel 連結。'); return; }
              if (apply(() => editor.createLink(link))) setPanel('format');
            }}>套用連結</Button></>}
        </>}
      </Stack>
    </Drawer>
  </>;
}
