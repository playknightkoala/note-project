import { ActionIcon, Anchor, Breadcrumbs, Burger, Menu, Text } from '@mantine/core';
import { useClipboard, useMediaQuery } from '@mantine/hooks';
import { Copy, Link2, MoreHorizontal, Star, StarOff, Trash2, Maximize2, Minimize2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { Breadcrumb, PageKind } from '@shared/api';
import { useDuplicatePage, useToggleFavorite, useTrashPage, useTree } from '../../api/pages.ts';
import { useShell } from './AppShell.tsx';
import { SaveStatus } from '../page/SaveStatus.tsx';
import type { SaveState } from '../page/useAutosave.ts';

interface Props {
  page: { id: string; kind: PageKind; title: string; icon: string | null; fullWidth: boolean };
  breadcrumbs: Breadcrumb[];
  saveStatus: SaveState; saveError: string | null; onRetry: () => void;
  onToggleFullWidth: () => void;
}

export function TopBar({ page, breadcrumbs, saveStatus, saveError, onRetry, onToggleFullWidth }: Props) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const shell = useShell();
  const tree = useTree();
  const favorite = useToggleFavorite();
  const trash = useTrashPage();
  const duplicate = useDuplicatePage();
  const navigate = useNavigate();
  const clipboard = useClipboard();
  const isFavorite = tree.data?.find(node => node.id === page.id)?.isFavorite ?? false;
  const crumbs = breadcrumbs.map((crumb, i) => {
    const title = (crumb.id === page.id ? page.title : crumb.title) || '無標題';
    const icon = crumb.id === page.id ? page.icon : crumb.icon;
    return <Anchor key={crumb.id} component={Link} to={`/p/${crumb.id}`} size="sm" c={i === breadcrumbs.length - 1 ? undefined : 'dimmed'} className="crumb">
      {icon && <span className="crumb__icon">{icon}</span>}{title}
    </Anchor>;
  });
  const visibleCrumbs = isMobile && crumbs.length > 2 ? [<Text key="ellipsis" size="sm" c="dimmed">…</Text>, ...crumbs.slice(-2)] : crumbs;
  return <div className="topbar">
    {isMobile && <Burger opened={shell.sidebarOpen} onClick={shell.toggleSidebar} size="sm" aria-label="開啟側邊欄" />}
    <Breadcrumbs separator="/" className="topbar__crumbs">{visibleCrumbs}</Breadcrumbs>
    <span style={{ flex: 1 }} />
    <SaveStatus status={saveStatus} error={saveError} onRetry={onRetry} />
    <Menu position="bottom-end" shadow="md" width={220}>
      <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="頁面選單"><MoreHorizontal size={18} /></ActionIcon></Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={isFavorite ? <StarOff size={16} /> : <Star size={16} />} onClick={() => favorite.mutate({ id: page.id, favorite: !isFavorite })}>{isFavorite ? '移除最愛' : '加入最愛'}</Menu.Item>
        <Menu.Item leftSection={<Link2 size={16} />} onClick={() => clipboard.copy(`${window.location.origin}/p/${page.id}`)}>{clipboard.copied ? '已複製連結' : '複製連結'}</Menu.Item>
        {page.kind === 'page' && <Menu.Item leftSection={<Copy size={16} />} onClick={() => duplicate.mutate(page.id, { onSuccess: result => navigate(`/p/${result.page.id}`) })}>複製頁面</Menu.Item>}
        <Menu.Item leftSection={page.fullWidth ? <Minimize2 size={16} /> : <Maximize2 size={16} />} onClick={onToggleFullWidth}>{page.fullWidth ? '一般寬度' : '全寬'}</Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" leftSection={<Trash2 size={16} />} onClick={() => trash.mutate({ id: page.id }, { onSuccess: () => navigate('/') })}>移至垃圾桶</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  </div>;
}
