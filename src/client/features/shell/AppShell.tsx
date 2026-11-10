import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppShell as MantineAppShell, Avatar, Group, Menu, ScrollArea, Text, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { ChevronsUpDown, LogOut, Moon, Plus, Search, Settings, Sun, Table2, Trash2 } from 'lucide-react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useLogout, useMe } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';
import { useCreatePage, useTree } from '../../api/pages.ts';
import { PageTree } from './PageTree.tsx';
import { PageTreeItem } from './PageTreeItem.tsx';
import { buildTreeIndex } from './treeIndex.ts';
import type { FlatRow } from './treeDrag.ts';
import { CommandPalette } from '../search/CommandPalette.tsx';
import { OfflineStatus } from '../../offline/OfflineStatus.tsx';
import { AppUpdates } from '../../updates/AppUpdates.tsx';
import { useShares } from '../../api/shares.ts';
import { ShareDialogHost } from '../share/ShareDialog.tsx';
import { SharedTree } from '../share/SharedTree.tsx';

export const SIDEBAR_BREAKPOINT = 768;
interface ShellContext { sidebarOpen: boolean; toggleSidebar: () => void; closeSidebar: () => void }
const ShellCtx = createContext<ShellContext>({ sidebarOpen: false, toggleSidebar: () => {}, closeSidebar: () => {} });
export const useShell = () => useContext(ShellCtx);

export function AppShell() {
  const me = useMe();
  const logout = useLogout();
  const tree = useTree();
  const shares = useShares();
  const create = useCreatePage();
  const navigate = useNavigate();
  const location = useLocation();
  const { pageId } = useParams();
  const isMobile = useMediaQuery(`(max-width: ${SIDEBAR_BREAKPOINT - 1}px)`) ?? false;
  const [opened, { toggle, close }] = useDisclosure(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => { try { return localStorage.getItem('notes:sidebar-collapsed') === '1'; } catch { return false; } });
  const toggleDesktop = () => setDesktopCollapsed(value => { try { localStorage.setItem('notes:sidebar-collapsed', value ? '0' : '1'); } catch { /* ignore */ } return !value; });
  const [searchOpened, setSearchOpened] = useState(false);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSearchOpened(value => !value);
      }
      // Ctrl/⌘+\ toggles the sidebar; Ctrl/⌘+Alt+N creates a page (plain Ctrl+N is reserved by browsers).
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '\\') { event.preventDefault(); if (isMobileRef.current) toggleRef.current(); else toggleDesktopRef.current(); }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newPageRef.current(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  const index = useMemo(() => buildTreeIndex(tree.data ?? []), [tree.data]);
  const user = me.data;
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const signOut = () => logout.mutate(undefined, {
    onSuccess: () => navigate('/login', { replace: true }),
    onError: error => setLogoutError(errorText(error)),
  });
  const newPage = () => create.mutate({}, { onSuccess: result => { close(); navigate(`/p/${result.page.id}`); } });
  const newPageRef = useRef(newPage); newPageRef.current = newPage;
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const toggleDesktopRef = useRef(toggleDesktop); toggleDesktopRef.current = toggleDesktop;
  const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;
  const newDatabase = () => create.mutate({ kind: 'database' }, { onSuccess: result => { close(); navigate(`/p/${result.page.id}`); } });
  const shell = useMemo<ShellContext>(() => ({ sidebarOpen: isMobile ? opened : !desktopCollapsed, toggleSidebar: isMobile ? toggle : toggleDesktop, closeSidebar: close }), [opened, toggle, close, isMobile, desktopCollapsed]);
  const favoriteRows: FlatRow[] = index.favorites.map((node, i) => ({ id: node.id, parentId: null, depth: 0, index: i, node }));
  const incoming = shares.data?.incoming ?? [];
  return <ShellCtx.Provider value={shell}><ShareDialogHost>
    <MantineAppShell navbar={{ width: 260, breakpoint: SIDEBAR_BREAKPOINT, collapsed: { mobile: !opened, desktop: desktopCollapsed } }} padding={0} className="app-shell">
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
          <button type="button" className="sidebar-button" title="搜尋（Ctrl / ⌘ K）" onClick={() => { close(); setSearchOpened(true); }}><Search size={15} /><span>搜尋</span></button>
          <button type="button" className="sidebar-button" title="新增頁面（Ctrl / ⌘ Alt N）" onClick={newPage}><Plus size={15} /><span>新增頁面</span></button>
          <button type="button" className="sidebar-button" onClick={newDatabase}><Table2 size={15} /><span>新增資料庫</span></button>
        </div>
        <ScrollArea className="sidebar-scroll" type="auto">
          {favoriteRows.length > 0 && <>
            <div className="sidebar-section">最愛</div>
            <div className="page-tree">{favoriteRows.map(row => <PageTreeItem key={row.id} row={row} depth={0} active={row.id === pageId} dragging={false} dragEnabled={false} />)}</div>
          </>}
          <div className="sidebar-section">頁面</div>
          {tree.isPending ? <Text size="xs" c="dimmed" px="sm">載入中…</Text> : <PageTree index={index} currentId={pageId ?? null} dragEnabled={!isMobile} />}
          {incoming.length > 0 && <>
            <div className="sidebar-section">與我共用</div>
            <SharedTree shares={incoming} currentId={pageId ?? null} />
          </>}
        </ScrollArea>
        <div className="sidebar-footer">
          <Link to="/trash" className={`sidebar-button${location.pathname === '/trash' ? ' sidebar-button--active' : ''}`}><Trash2 size={15} /><span>垃圾桶</span></Link>
          <Link to="/settings" className={`sidebar-button${location.pathname === '/settings' ? ' sidebar-button--active' : ''}`}><Settings size={15} /><span>設定</span></Link>
          <AppUpdates />
        </div>
      </MantineAppShell.Navbar>
      <MantineAppShell.Main className="app-main">
        <OfflineStatus />
        {create.error && <Alert color="red" m="sm" title="無法新增頁面">{errorText(create.error)}</Alert>}
        {logoutError && <Alert color="red" variant="light" m="md" withCloseButton onClose={() => setLogoutError(null)} title="登出失敗">{logoutError}</Alert>}
        <Outlet />
      </MantineAppShell.Main>
    </MantineAppShell>
    {user && <CommandPalette key={user.id} userId={user.id} opened={searchOpened} onClose={() => setSearchOpened(false)} />}
  </ShareDialogHost></ShellCtx.Provider>;
}
