import { createContext, useContext, useMemo } from 'react';
import { AppShell as MantineAppShell, Avatar, Group, Menu, ScrollArea, Text, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { ChevronsUpDown, LogOut, Moon, Plus, Search, Settings, Sun, Trash2 } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useLogout, useMe } from '../../api/auth.ts';
import { useCreatePage, useTree } from '../../api/pages.ts';
import { PageTree } from './PageTree.tsx';
import { PageTreeItem } from './PageTreeItem.tsx';
import { buildTreeIndex } from './treeIndex.ts';
import type { FlatRow } from './treeDrag.ts';

export const SIDEBAR_BREAKPOINT = 768;
interface ShellContext { sidebarOpen: boolean; toggleSidebar: () => void; closeSidebar: () => void }
const ShellCtx = createContext<ShellContext>({ sidebarOpen: false, toggleSidebar: () => {}, closeSidebar: () => {} });
export const useShell = () => useContext(ShellCtx);

export function AppShell() {
  const me = useMe();
  const logout = useLogout();
  const tree = useTree();
  const create = useCreatePage();
  const navigate = useNavigate();
  const location = useLocation();
  const { pageId } = useParams();
  const isMobile = useMediaQuery(`(max-width: ${SIDEBAR_BREAKPOINT - 1}px)`) ?? false;
  const [opened, { toggle, close }] = useDisclosure(false);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const index = useMemo(() => buildTreeIndex(tree.data ?? []), [tree.data]);
  const user = me.data;
  const signOut = () => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });
  const newPage = () => create.mutate({}, { onSuccess: result => { close(); navigate(`/p/${result.page.id}`); } });
  const shell = useMemo<ShellContext>(() => ({ sidebarOpen: opened, toggleSidebar: toggle, closeSidebar: close }), [opened, toggle, close]);
  const favoriteRows: FlatRow[] = index.favorites.map((node, i) => ({ id: node.id, parentId: null, depth: 0, index: i, node }));
  return <ShellCtx.Provider value={shell}>
    <MantineAppShell navbar={{ width: 260, breakpoint: SIDEBAR_BREAKPOINT, collapsed: { mobile: !opened } }} padding={0} className="app-shell">
      <MantineAppShell.Navbar className="sidebar" onClick={isMobile ? close : undefined}>
        <Menu position="bottom-start" width={240} shadow="md">
          <Menu.Target>
            <UnstyledButton className="sidebar-workspace" aria-label="帳號選單" onClick={event => event.stopPropagation()}>
              <Group gap="xs" wrap="nowrap">
                <Avatar size={22} radius="sm" color="blue">{user?.displayName.slice(0, 1)}</Avatar>
                <Text fw={600} size="sm" truncate style={{ flex: 1 }}>{user?.displayName ?? ''} 的筆記</Text>
                <ChevronsUpDown size={14} />
              </Group>
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{user?.email}</Menu.Label>
            <Menu.Item leftSection={<Settings size={16} />} component={Link} to="/settings">設定</Menu.Item>
            <Menu.Item leftSection={scheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}>{scheme === 'dark' ? '淺色模式' : '深色模式'}</Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<LogOut size={16} />} onClick={signOut}>登出</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <div className="sidebar-actions">
          <button type="button" className="sidebar-button" disabled title="搜尋將在之後的里程碑加入"><Search size={15} /><span>搜尋</span></button>
          <button type="button" className="sidebar-button" onClick={newPage}><Plus size={15} /><span>新增頁面</span></button>
        </div>
        <ScrollArea className="sidebar-scroll" type="auto">
          {favoriteRows.length > 0 && <>
            <div className="sidebar-section">最愛</div>
            <div className="page-tree">{favoriteRows.map(row => <PageTreeItem key={row.id} row={row} depth={0} active={row.id === pageId} dragging={false} dragEnabled={false} />)}</div>
          </>}
          <div className="sidebar-section">頁面</div>
          {tree.isPending ? <Text size="xs" c="dimmed" px="sm">載入中…</Text> : <PageTree index={index} currentId={pageId ?? null} dragEnabled={!isMobile} />}
        </ScrollArea>
        <div className="sidebar-footer">
          <Link to="/trash" className={`sidebar-button${location.pathname === '/trash' ? ' sidebar-button--active' : ''}`}><Trash2 size={15} /><span>垃圾桶</span></Link>
          <Link to="/settings" className={`sidebar-button${location.pathname === '/settings' ? ' sidebar-button--active' : ''}`}><Settings size={15} /><span>設定</span></Link>
        </div>
      </MantineAppShell.Navbar>
      <MantineAppShell.Main className="app-main"><Outlet /></MantineAppShell.Main>
    </MantineAppShell>
  </ShellCtx.Provider>;
}
