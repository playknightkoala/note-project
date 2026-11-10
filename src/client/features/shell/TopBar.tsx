import { ActionIcon, Anchor, Badge, Breadcrumbs, Burger, Button, Menu, Text, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { MoreHorizontal, Users } from 'lucide-react';
import { Link } from 'react-router';
import type { Breadcrumb, PageAccess, PageKind } from '@shared/api';
import { roleLabels } from '@shared/shares';
import { useTree } from '../../api/pages.ts';
import { useShareDialog } from '../share/ShareDialog.tsx';
import { PageMenuItems } from './PageMenuItems.tsx';
import { useShell } from './AppShell.tsx';
import { SaveStatus } from '../page/SaveStatus.tsx';
import type { SaveState } from '../page/useAutosave.ts';

interface Props {
  page: { id: string; kind: PageKind; title: string; icon: string | null; fullWidth: boolean };
  breadcrumbs: Breadcrumb[];
  saveStatus: SaveState; saveError: string | null; onRetry: () => void;
  onToggleFullWidth: () => void;
  smallText: boolean; onToggleSmallText: () => void;
  onOpenHistory: () => void;
  access?: PageAccess | undefined;
}

export function TopBar({ page, breadcrumbs, saveStatus, saveError, onRetry, onToggleFullWidth, smallText, onToggleSmallText, onOpenHistory, access }: Props) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const shell = useShell();
  const tree = useTree();
  const openShare = useShareDialog();
  const shared = tree.data?.find(node => node.id === page.id)?.shared === true;
  const crumbs = breadcrumbs.map((crumb, i) => {
    const title = (crumb.id === page.id ? page.title : crumb.title) || '無標題';
    const icon = crumb.id === page.id ? page.icon : crumb.icon;
    return <Anchor key={crumb.id} component={Link} to={`/p/${crumb.id}`} size="sm" c={i === breadcrumbs.length - 1 ? undefined : 'dimmed'} className="crumb">
      {icon && <span className="crumb__icon">{icon}</span>}{title}
    </Anchor>;
  });
  const visibleCrumbs = isMobile && crumbs.length > 2 ? [<Text key="ellipsis" size="sm" c="dimmed">…</Text>, ...crumbs.slice(-2)] : crumbs;
  return <div className="topbar">
    {(isMobile || !shell.sidebarOpen) && <Burger opened={shell.sidebarOpen} onClick={shell.toggleSidebar} size="sm" aria-label="開啟側邊欄" title="側邊欄（Ctrl / ⌘ \\）" />}
    <Breadcrumbs separator="/" className="topbar__crumbs">{visibleCrumbs}</Breadcrumbs>
    <span style={{ flex: 1 }} />
    <SaveStatus status={saveStatus} error={saveError} onRetry={onRetry} />
    {access && <Tooltip label={`${access.owner.name} 與你共用`}><Badge variant="light" color={access.role === 'editor' ? 'blue' : 'gray'} className="topbar__access">{roleLabels[access.role]}</Badge></Tooltip>}
    {!access && page.kind !== 'row' && <Button variant={shared ? 'light' : 'subtle'} color={shared ? 'blue' : 'gray'} size="compact-sm" leftSection={<Users size={14} />} className="topbar__share"
      onClick={() => openShare({ id: page.id, kind: page.kind, title: page.title })}>{shared ? '已分享' : '分享'}</Button>}
    <Menu position="bottom-end" shadow="md" width={220}>
      <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="頁面選單"><MoreHorizontal size={18} /></ActionIcon></Menu.Target>
      <Menu.Dropdown>
        <PageMenuItems page={page} access={access} onToggleFullWidth={onToggleFullWidth} smallText={smallText} onToggleSmallText={onToggleSmallText} onOpenHistory={onOpenHistory} />
      </Menu.Dropdown>
    </Menu>
  </div>;
}
