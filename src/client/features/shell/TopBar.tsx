import { ActionIcon, Anchor, Breadcrumbs, Burger, Menu, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { Breadcrumb, PageKind } from '@shared/api';
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
}

export function TopBar({ page, breadcrumbs, saveStatus, saveError, onRetry, onToggleFullWidth, smallText, onToggleSmallText, onOpenHistory }: Props) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const shell = useShell();
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
    <Menu position="bottom-end" shadow="md" width={220}>
      <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label="頁面選單"><MoreHorizontal size={18} /></ActionIcon></Menu.Target>
      <Menu.Dropdown>
        <PageMenuItems page={page} onToggleFullWidth={onToggleFullWidth} smallText={smallText} onToggleSmallText={onToggleSmallText} onOpenHistory={onOpenHistory} />
      </Menu.Dropdown>
    </Menu>
  </div>;
}
