import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Text } from '@mantine/core';
import { useMovePage } from '../../api/pages.ts';
import { useUiState } from '../../app/uiState.tsx';
import { PageTreeItem } from './PageTreeItem.tsx';
import { flattenTree, projectDrop } from './treeDrag.ts';
import type { DropProjection } from './treeDrag.ts';
import type { TreeIndex } from './treeIndex.ts';

export const INDENT = 14;

export function PageTree({ index, currentId, dragEnabled }: { index: TreeIndex; currentId: string | null; dragEnabled: boolean }) {
  const { expanded } = useUiState();
  const move = useMovePage();
  const rows = useMemo(() => flattenTree(index, expanded), [index, expanded]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [projection, setProjection] = useState<DropProjection | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragStart = (event: DragStartEvent) => { setActiveId(String(event.active.id)); setProjection(null); };
  const onDragMove = (event: DragMoveEvent) => {
    if (!event.over) { setProjection(null); return; }
    setProjection(projectDrop(rows, String(event.active.id), String(event.over.id), event.delta.x, INDENT));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const target = event.over ? projectDrop(rows, String(event.active.id), String(event.over.id), event.delta.x, INDENT) : null;
    setActiveId(null); setProjection(null);
    if (target) move.mutate({ id: String(event.active.id), parentId: target.parentId, index: target.index });
  };
  if (rows.length === 0) return <Text size="xs" c="dimmed" px="sm" py={4}>還沒有頁面。</Text>;
  const activeRow = activeId ? rows.find(row => row.id === activeId) : undefined;
  const items = rows.map(row => <PageTreeItem key={row.id} row={row} active={row.id === currentId}
    depth={row.id === activeId && projection ? projection.depth : row.depth} dragging={row.id === activeId} dragEnabled={dragEnabled} />);
  if (!dragEnabled) return <div className="page-tree">{items}</div>;
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); setProjection(null); }}>
    <SortableContext items={rows.map(row => row.id)} strategy={verticalListSortingStrategy}>
      <div className="page-tree">{items}</div>
    </SortableContext>
    <DragOverlay dropAnimation={null}>{activeRow && <div className="tree-row tree-row--overlay"><span className="tree-row__icon">{activeRow.node.icon ?? '📄'}</span><span className="tree-row__title">{activeRow.node.title || '無標題'}</span></div>}</DragOverlay>
  </DndContext>;
}
