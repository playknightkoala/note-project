import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionIcon, Menu } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { ChevronRight, Copy, Database, FileText, Link2, MoreHorizontal, Plus, Star, StarOff, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCreatePage, useDuplicatePage, useToggleFavorite, useTrashPage } from '../../api/pages.ts';
import { useUiState } from '../../app/uiState.tsx';
import { INDENT } from './PageTree.tsx';
import type { FlatRow } from './treeDrag.ts';

interface Props { row: FlatRow; depth: number; active: boolean; dragging: boolean; dragEnabled: boolean }

export function PageTreeItem({ row, depth, active, dragging, dragEnabled }: Props) {
  const { expanded, setExpanded } = useUiState();
  const navigate = useNavigate();
  const create = useCreatePage();
  const favorite = useToggleFavorite();
  const trash = useTrashPage();
  const duplicate = useDuplicatePage();
  const clipboard = useClipboard();
  const sortable = useSortable({ id: row.id, disabled: !dragEnabled });
  const node = row.node;
  const open = expanded.has(node.id);
  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, paddingLeft: 6 + depth * INDENT, opacity: dragging ? 0.4 : 1 };
  const addChild = () => create.mutate({ parentId: node.id }, { onSuccess: result => { setExpanded(node.id, true); navigate(`/p/${result.page.id}`); } });
  return <div ref={sortable.setNodeRef} style={style} className={`tree-row${active ? ' tree-row--active' : ''}`} data-id={node.id}
    {...sortable.attributes} {...sortable.listeners} onClick={() => navigate(`/p/${node.id}`)} role="treeitem" aria-expanded={node.hasChildren ? open : undefined} aria-level={depth + 1}>
    <button type="button" className={`tree-row__chevron${node.hasChildren ? '' : ' tree-row__chevron--empty'}`} aria-label={open ? '收合' : '展開'} tabIndex={-1}
      onClick={event => { event.stopPropagation(); if (node.hasChildren) setExpanded(node.id, !open); }} onPointerDown={event => event.stopPropagation()}>
      <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
    </button>
    <span className="tree-row__icon">{node.icon ?? (node.kind === 'database' ? <Database size={15} /> : <FileText size={15} />)}</span>
    <span className="tree-row__title">{node.title || '無標題'}</span>
    <span className="tree-row__actions" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <Menu position="bottom-start" shadow="md" width={200} withinPortal>
        <Menu.Target><ActionIcon variant="subtle" color="gray" size="sm" aria-label="頁面選項"><MoreHorizontal size={14} /></ActionIcon></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={node.isFavorite ? <StarOff size={14} /> : <Star size={14} />} onClick={() => favorite.mutate({ id: node.id, favorite: !node.isFavorite })}>{node.isFavorite ? '移除最愛' : '加入最愛'}</Menu.Item>
          <Menu.Item leftSection={<Link2 size={14} />} onClick={() => clipboard.copy(`${window.location.origin}/p/${node.id}`)}>複製連結</Menu.Item>
          {node.kind === 'page' && <Menu.Item leftSection={<Copy size={14} />} onClick={() => duplicate.mutate(node.id)}>複製頁面</Menu.Item>}
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => trash.mutate({ id: node.id }, { onSuccess: () => { if (active) navigate('/'); } })}>移至垃圾桶</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {node.kind !== 'database' && <ActionIcon variant="subtle" color="gray" size="sm" aria-label="新增子頁面" onClick={addChild}><Plus size={14} /></ActionIcon>}
    </span>
  </div>;
}
