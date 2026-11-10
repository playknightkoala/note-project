import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionIcon, Menu } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { ChevronRight, Copy, Database, ExternalLink, FileText, Link2, MoreHorizontal, Plus, Star, StarOff, Trash2, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCreatePage, useDuplicatePage, useToggleFavorite, useTrashPage } from '../../api/pages.ts';
import { useUiState } from '../../app/uiState.tsx';
import { INDENT } from './PageTree.tsx';
import type { FlatRow } from './treeDrag.ts';
import { ContextMenu } from './ContextMenu.tsx';
import { useShareDialog } from '../share/ShareDialog.tsx';

interface Props { row: FlatRow; depth: number; active: boolean; dragging: boolean; dragEnabled: boolean }

export function PageTreeItem({ row, depth, active, dragging, dragEnabled }: Props) {
  const { expanded, setExpanded } = useUiState();
  const [menuOpened, setMenuOpened] = useState(false);
  const navigate = useNavigate();
  const create = useCreatePage();
  const favorite = useToggleFavorite();
  const trash = useTrashPage();
  const duplicate = useDuplicatePage();
  const clipboard = useClipboard();
  const openShare = useShareDialog();
  const sortable = useSortable({ id: row.id, disabled: !dragEnabled });
  const node = row.node;
  const open = expanded.has(node.id);
  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, paddingLeft: 6 + depth * INDENT, opacity: dragging ? 0.4 : 1 };
  const addChild = () => create.mutate({ parentId: node.id }, { onSuccess: result => { setExpanded(node.id, true); navigate(`/p/${result.page.id}`); } });
  const items = <>
    <Menu.Item component="a" href={`/p/${node.id}`} target="_blank" rel="noopener noreferrer" leftSection={<ExternalLink size={14} />}>在新分頁開啟</Menu.Item>
    <Menu.Item leftSection={<Users size={14} />} onClick={() => openShare({ id: node.id, kind: node.kind, title: node.title })}>分享</Menu.Item>
    <Menu.Item leftSection={node.isFavorite ? <StarOff size={14} /> : <Star size={14} />} onClick={() => favorite.mutate({ id: node.id, favorite: !node.isFavorite })}>{node.isFavorite ? '移除最愛' : '加入最愛'}</Menu.Item>
    <Menu.Item leftSection={<Link2 size={14} />} onClick={() => clipboard.copy(`${window.location.origin}/p/${node.id}`)}>複製連結</Menu.Item>
    {node.kind === 'page' && <Menu.Item leftSection={<Copy size={14} />} onClick={() => duplicate.mutate(node.id)}>複製頁面</Menu.Item>}
    {node.kind !== 'database' && <Menu.Item leftSection={<Plus size={14} />} onClick={addChild}>新增子頁面</Menu.Item>}
    <Menu.Divider />
    <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => trash.mutate({ id: node.id }, { onSuccess: () => { if (active) navigate('/'); } })}>移至垃圾桶</Menu.Item>
  </>;
  return <ContextMenu label="側欄頁面右鍵選單" items={items}>{handlers => <div ref={sortable.setNodeRef} style={style} className={`tree-row${active ? ' tree-row--active' : ''}`} data-id={node.id}
    {...sortable.attributes} {...sortable.listeners} onClick={() => navigate(`/p/${node.id}`)} {...handlers} data-menu-open={menuOpened || undefined} role="treeitem" aria-expanded={node.hasChildren ? open : undefined} aria-level={depth + 1}>
    <button type="button" className={`tree-row__chevron${node.hasChildren ? '' : ' tree-row__chevron--empty'}`} aria-label={open ? '收合' : '展開'} tabIndex={-1}
      onClick={event => { event.stopPropagation(); if (node.hasChildren) setExpanded(node.id, !open); }} onPointerDown={event => event.stopPropagation()}>
      <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
    </button>
    <span className="tree-row__icon">{node.icon ?? (node.kind === 'database' ? <Database size={15} /> : <FileText size={15} />)}</span>
    <span className="tree-row__title">{node.title || '無標題'}</span>
    {node.shared && <span className="tree-row__shared" title="已分享" aria-label="已分享"><Users size={12} /></span>}
    <span className="tree-row__actions" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
      <Menu opened={menuOpened} onChange={setMenuOpened} position="bottom-start" shadow="md" width={200} withinPortal>
        <Menu.Target><ActionIcon variant="subtle" color="gray" size="sm" aria-label="頁面選項"><MoreHorizontal size={14} /></ActionIcon></Menu.Target>
        <Menu.Dropdown>{items}</Menu.Dropdown>
      </Menu>
      {node.kind !== 'database' && <ActionIcon variant="subtle" color="gray" size="sm" aria-label="新增子頁面" onClick={addChild}><Plus size={14} /></ActionIcon>}
    </span>
  </div>}</ContextMenu>;
}
