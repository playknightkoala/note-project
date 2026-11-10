import { Menu } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { ALargeSmall, Copy, ExternalLink, History, Link2, Maximize2, Minimize2, Star, StarOff, Trash2, Users } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { PageAccess, PageKind } from '@shared/api';
import { useDuplicatePage, useToggleFavorite, useTrashPage, useTree } from '../../api/pages.ts';
import { useShareDialog } from '../share/ShareDialog.tsx';

export interface PageMenuProps {
  page: { id: string; kind: PageKind; fullWidth: boolean; title?: string };
  /** Set on a page somebody else shares with the user: everything that organises or changes the page is the owner's. */
  access?: PageAccess | undefined;
  onToggleFullWidth: () => void;
  smallText: boolean; onToggleSmallText: () => void; onOpenHistory: () => void;
}
/** Shared by the top-bar button and the page's desktop context menu. */
export function PageMenuItems({ page, access, onToggleFullWidth, smallText, onToggleSmallText, onOpenHistory }: PageMenuProps) {
  const tree = useTree();
  const favorite = useToggleFavorite();
  const trash = useTrashPage();
  const duplicate = useDuplicatePage();
  const navigate = useNavigate();
  const clipboard = useClipboard();
  const openShare = useShareDialog();
  const isFavorite = tree.data?.find(node => node.id === page.id)?.isFavorite ?? false;
  if (access) return <>
    <Menu.Item component="a" href={`/p/${page.id}`} target="_blank" rel="noopener noreferrer" leftSection={<ExternalLink size={16} />}>在新分頁開啟</Menu.Item>
    <Menu.Item leftSection={<Link2 size={16} />} onClick={() => clipboard.copy(`${window.location.origin}/p/${page.id}`)}>{clipboard.copied ? '已複製連結' : '複製連結'}</Menu.Item>
    <Menu.Item leftSection={<ALargeSmall size={16} />} onClick={onToggleSmallText}>{smallText ? '一般字體' : '小字體'}</Menu.Item>
  </>;
  return <>
    <Menu.Item component="a" href={`/p/${page.id}`} target="_blank" rel="noopener noreferrer" leftSection={<ExternalLink size={16} />}>在新分頁開啟</Menu.Item>
    {page.kind !== 'row' && <Menu.Item leftSection={<Users size={16} />} onClick={() => openShare({ id: page.id, kind: page.kind, title: page.title ?? '' })}>分享</Menu.Item>}
    <Menu.Item leftSection={isFavorite ? <StarOff size={16} /> : <Star size={16} />} onClick={() => favorite.mutate({ id: page.id, favorite: !isFavorite })}>{isFavorite ? '移除最愛' : '加入最愛'}</Menu.Item>
    <Menu.Item leftSection={<Link2 size={16} />} onClick={() => clipboard.copy(`${window.location.origin}/p/${page.id}`)}>{clipboard.copied ? '已複製連結' : '複製連結'}</Menu.Item>
    {page.kind === 'page' && <Menu.Item leftSection={<Copy size={16} />} onClick={() => duplicate.mutate(page.id, { onSuccess: result => navigate(`/p/${result.page.id}`) })}>複製頁面</Menu.Item>}
    <Menu.Item leftSection={page.fullWidth ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onClick={onToggleFullWidth}>{page.fullWidth ? '一般寬度' : '全寬'}</Menu.Item>
    <Menu.Item leftSection={<ALargeSmall size={16} />} onClick={onToggleSmallText}>{smallText ? '一般字體' : '小字體'}</Menu.Item>
    {page.kind !== 'database' && <Menu.Item leftSection={<History size={16} />} onClick={onOpenHistory}>頁面歷史</Menu.Item>}
    <Menu.Divider />
    <Menu.Item color="red" leftSection={<Trash2 size={16} />} onClick={() => trash.mutate({ id: page.id }, { onSuccess: () => navigate('/') })}>移至垃圾桶</Menu.Item>
  </>;
}
