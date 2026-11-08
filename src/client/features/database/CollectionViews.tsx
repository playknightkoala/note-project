import { useRef, useState } from 'react';
import { ActionIcon, Group, Menu, Text } from '@mantine/core';
import { ExternalLink, FileText, GripVertical, MoreHorizontal, Trash2 } from 'lucide-react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Link } from 'react-router';
import type { CellValue, DatabaseProperty, DatabaseRow, ViewConfig } from '@shared/database';
import { EditableCell } from './EditableCell.tsx';
import { ChoiceTag, CellDisplay } from './CellValueInput.tsx';
import { NewRowInput } from './NewRowInput.tsx';

interface Props {
  rows: DatabaseRow[]; properties: DatabaseProperty[]; config: ViewConfig;
  onSave: (row: DatabaseRow, propertyId: string, value: CellValue, version: number) => Promise<unknown>;
  onCreate: (title: string, values: Record<string, CellValue>) => Promise<unknown>;
  onTrash: (row: DatabaseRow) => void; onReload: () => void; adding: boolean; onCloseAdd: () => void;
}
function RowActions({ row, onTrash }: Pick<Props, 'onTrash'> & { row: DatabaseRow }) {
  return <Group gap={2} wrap="nowrap"><ActionIcon component={Link} to={`/p/${row.id}`} variant="subtle" color="gray" aria-label={`開啟資料列：${row.title || '無標題'}`}><ExternalLink size={14} /></ActionIcon>
    <Menu withinPortal><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`資料列選單：${row.title || '無標題'}`}><MoreHorizontal size={14} /></ActionIcon></Menu.Target>
      <Menu.Dropdown><Menu.Item component={Link} to={`/p/${row.id}`}>開啟為頁面</Menu.Item><Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => onTrash(row)}>移至垃圾桶</Menu.Item></Menu.Dropdown></Menu>
  </Group>;
}
export function ListView(props: Props) {
  const visible = props.properties.filter(property => !props.config.columns || props.config.columns.includes(property.id));
  return <div className="database-list" aria-label="資料庫清單">
    {props.rows.map(row => <div className="database-list-row" key={row.id}>
      <FileText size={16} className="database-list-icon" /><div className="database-list-title"><EditableCell property={null} value={row.title} version={row.version} label={`${row.title || '無標題'}／名稱`} onReload={props.onReload} onSave={(value, version) => props.onSave(row, 'title', value, version)} /></div>
      <div className="database-list-properties">{visible.map(property => <div className="database-list-property" key={property.id} title={property.name}><EditableCell property={property} value={row.values[property.id] ?? null} version={row.version} label={`${row.title || '無標題'}／${property.name}`} onReload={props.onReload} onSave={(value, version) => props.onSave(row, property.id, value, version)} /></div>)}</div>
      <RowActions row={row} onTrash={props.onTrash} />
    </div>)}
    {props.rows.length === 0 && <Text size="sm" c="dimmed" p="sm">尚無符合條件的資料列。</Text>}
    <NewRowInput key={String(props.adding)} opened={props.adding} onClose={props.onCloseAdd} onCreate={title => props.onCreate(title, {})} />
  </div>;
}
const EMPTY_GROUP = '__ungrouped__';
export function BoardView(props: Props & { onMove: (row: DatabaseRow, groupBy: string, choice: string | null) => void; moving: boolean }) {
  const group = props.properties.find(property => property.id === props.config.groupBy && property.type === 'select');
  const [active, setActive] = useState<DatabaseRow | null>(null);
  const dragged = useRef<DatabaseRow | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  if (!group) return <Text p="lg" c="dimmed">請在「編輯視圖」選擇單選欄位作為看板分組。</Text>;
  const groups = [...group.choices.map(choice => ({ id: choice.id, choice })), { id: EMPTY_GROUP, choice: null }];
  const move = (event: DragEndEvent) => {
    const row = dragged.current; dragged.current = null; setActive(null);
    if (!event.over || !row) return;
    const choice = String(event.over.id) === EMPTY_GROUP ? null : String(event.over.id);
    if ((row.values[group.id] ?? null) !== choice) props.onMove(row, group.id, choice);
  };
  return <DndContext sensors={sensors} onDragStart={event => { const row = props.rows.find(row => row.id === event.active.id) ?? null; dragged.current = row; setActive(row); }} onDragEnd={move} onDragCancel={() => { dragged.current = null; setActive(null); }} accessibility={{ screenReaderInstructions: { draggable: '使用拖曳把手移動卡片；鍵盤使用者可透過卡片選單的「移至」操作變更群組。' } }}>
    <div className="database-board" aria-label="資料庫看板">{groups.map(({ id, choice }) => {
      const rows = props.rows.filter(row => (row.values[group.id] ?? EMPTY_GROUP) === id);
      return <BoardColumn key={id} id={id} label={choice?.label ?? '未設定'}>
        <Group gap="xs" className="database-board-heading">{choice ? <ChoiceTag choice={choice} /> : <Text size="sm" c="dimmed">未設定</Text>}<Text size="xs" c="dimmed">{rows.length}</Text></Group>
        <div className="database-board-cards">{rows.map(row => <BoardCard key={row.id} row={row} group={group} props={props} />)}
          <NewRowInput onCreate={title => props.onCreate(title, { [group.id]: choice?.id ?? null })} />
        </div>
      </BoardColumn>;
    })}</div>
    {props.adding && <NewRowInput opened onClose={props.onCloseAdd} onCreate={title => props.onCreate(title, {})} />}
    <DragOverlay>{active && <div className="database-board-card database-board-overlay">{active.title || '無標題'}</div>}</DragOverlay>
  </DndContext>;
}
function BoardColumn({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <section ref={setNodeRef} className={`database-board-column${isOver ? ' database-board-column--over' : ''}`} aria-label={`群組：${label}`}>{children}</section>;
}
function BoardCard({ row, group, props }: { row: DatabaseRow; group: DatabaseProperty; props: Props & { onMove: (row: DatabaseRow, groupBy: string, choice: string | null) => void; moving: boolean } }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: row.id, disabled: props.moving });
  const visible = props.properties.filter(property => property.id !== group.id && (!props.config.columns || props.config.columns.includes(property.id)));
  return <div ref={setNodeRef} className={`database-board-card${isDragging ? ' database-board-card--dragging' : ''}`}>
    <div className="database-board-card-title"><button type="button" className="database-drag-handle" aria-label={`拖曳卡片：${row.title || '無標題'}`} {...attributes} {...listeners}><GripVertical size={14} /></button>
      <EditableCell property={null} value={row.title} version={row.version} label={`${row.title || '無標題'}／名稱`} onReload={props.onReload} onSave={(value, version) => props.onSave(row, 'title', value, version)} />
      <Menu withinPortal><Menu.Target><ActionIcon size="sm" color="gray" variant="subtle" aria-label={`卡片選單：${row.title || '無標題'}`}><MoreHorizontal size={14} /></ActionIcon></Menu.Target>
        <Menu.Dropdown><Menu.Item component={Link} to={`/p/${row.id}`}>開啟為頁面</Menu.Item><Menu.Label>移至</Menu.Label>{[...group.choices.map(choice => ({ id: choice.id, label: choice.label })), { id: '', label: '未設定' }].map(choice => <Menu.Item key={choice.id} disabled={props.moving || (row.values[group.id] ?? '') === choice.id} onClick={() => props.onMove(row, group.id, choice.id || null)}>{choice.label}</Menu.Item>)}
          <Menu.Divider /><Menu.Item color="red" onClick={() => props.onTrash(row)}>移至垃圾桶</Menu.Item></Menu.Dropdown>
      </Menu>
    </div>
    {visible.map(property => <div className="database-board-property" key={property.id}><span>{property.name}</span><CellDisplay property={property} value={row.values[property.id] ?? null} /></div>)}
  </div>;
}
