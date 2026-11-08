import { BasicTextStyleButton, blockTypeSelectItems, ColorStyleButton, CreateLinkButton, FormattingToolbar, TableCellMergeButton, useBlockNoteEditor, useEditorState } from '@blocknote/react';
import { ActionIcon, Button, Divider, Group, Menu, Tooltip } from '@mantine/core';
import { Check, ChevronRight, Code2, MessageSquare, RemoveFormatting, SmilePlus } from 'lucide-react';
import type { AppEditor } from './schema.ts';

export function SelectionToolbar({ onAnnotate }: { onAnnotate: (mode: 'comment' | 'reaction') => void }) {
  const editor = useBlockNoteEditor() as AppEditor;
  const selectionEmpty = useEditorState({ editor, selector: ({ editor }) => editor.prosemirrorState.selection.empty });
  const isFile = useEditorState({ editor, selector: ({ editor }) => ['image', 'video', 'audio', 'file'].includes(editor.getTextCursorPosition().block.type) });
  if (isFile) return <FormattingToolbar />;
  return <FormattingToolbar><div className="selection-panel" aria-label="文字選取工具" onMouseDown={event => { if (!(event.target as Element).closest('input')) event.preventDefault(); }}>
    <SelectionBlockType editor={editor} />
    <Divider />
    <Group gap={2} wrap="wrap" className="selection-panel__formats">
      <TableCellMergeButton />
      <ColorStyleButton /><BasicTextStyleButton basicTextStyle="bold" /><BasicTextStyleButton basicTextStyle="italic" />
      <BasicTextStyleButton basicTextStyle="underline" /><BasicTextStyleButton basicTextStyle="strike" />
      <BasicTextStyleButton basicTextStyle="code" /><CreateLinkButton />
      <Tooltip label="清除文字格式"><ActionIcon aria-label="清除文字格式" variant="subtle" color="gray" onClick={() => {
        // Annotation anchors are content, not presentation, so formatting never removes them.
        editor.focus(); editor.removeStyles({ bold: true, italic: true, underline: true, strike: true, code: true, textColor: 'default', backgroundColor: 'default' });
      }}><RemoveFormatting size={16} /></ActionIcon></Tooltip>
    </Group>
    <Divider />
    <Group gap={4} justify="space-between">
      <Button variant="subtle" color="gray" size="compact-sm" leftSection={<MessageSquare size={16} />} disabled={selectionEmpty} onClick={() => onAnnotate('comment')}>留言</Button>
      <Tooltip label="加表情反應"><ActionIcon aria-label="加表情反應" variant="subtle" color="gray" disabled={selectionEmpty} onClick={() => onAnnotate('reaction')}><SmilePlus size={18} /></ActionIcon></Tooltip>
    </Group>
  </div></FormattingToolbar>;
}

function SelectionBlockType({ editor }: { editor: AppEditor }) {
  const blocks = useEditorState({ editor, selector: ({ editor }) => editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block] });
  const items = [...blockTypeSelectItems(editor), { name: '程式碼', type: 'codeBlock', props: {}, icon: () => <Code2 size={16} /> }];
  const matches = (item: typeof items[number]) => blocks[0]?.type === item.type && Object.entries(item.props ?? {}).every(([key, value]) => (blocks[0]?.props as Record<string, unknown>)[key] === value);
  const current = items.find(matches); const Icon = current?.icon;
  return <Menu position="right-start" shadow="md" width={220} withinPortal={false}>
    <Menu.Target><Button className="selection-panel__type" fullWidth size="compact-sm" variant="subtle" color="gray" leftSection={Icon ? <Icon size={16} /> : undefined} rightSection={<ChevronRight size={14} />} aria-label="轉換段落類型">{current?.name ?? '轉換段落類型'}</Button></Menu.Target>
    <Menu.Dropdown style={{ maxHeight: 'min(480px, calc(100vh - 32px))', overflowY: 'auto' }} onMouseDown={event => event.preventDefault()}>
      {items.map(item => <Menu.Item key={`${item.type}-${item.name}`} leftSection={<item.icon size={16} />} rightSection={matches(item) ? <Check size={14} /> : undefined} onClick={() => {
        editor.focus(); editor.transact(() => { for (const block of blocks) editor.updateBlock(block, { type: item.type, props: item.props } as Parameters<AppEditor['updateBlock']>[1]); });
      }}>{item.name}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu>;
}
