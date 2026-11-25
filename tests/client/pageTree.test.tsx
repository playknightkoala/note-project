// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Outlet, RouterProvider, createMemoryRouter, useParams } from 'react-router';
import type { PageNode } from '../../src/shared/api.ts';
import type { IncomingShareDto } from '../../src/shared/shares.ts';
import { UiStateProvider } from '../../src/client/app/uiState.tsx';
import { PageTree } from '../../src/client/features/shell/PageTree.tsx';
import { buildTreeIndex } from '../../src/client/features/shell/treeIndex.ts';
import { SharedTree } from '../../src/client/features/share/SharedTree.tsx';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const node = (id: string, parentId: string | null, position: number, extra: Partial<PageNode> = {}): PageNode =>
  ({ id, parentId, kind: 'page', title: id, icon: null, position, isFavorite: false, favoritePosition: null, hasChildren: false, updatedAt: 0, ...extra });
// 旅行 (行程 (第一天), 預算), 筆記
const own = [node('旅行', null, 1024, { hasChildren: true }), node('行程', '旅行', 1024, { hasChildren: true }), node('第一天', '行程', 1024), node('預算', '旅行', 2048), node('筆記', null, 2048)];
const share: IncomingShareDto = { pageId: '共用根', scope: 'subpages', role: 'viewer', owner: { id: crypto.randomUUID(), name: '擁有者' },
  tree: [node('共用根', null, 1024, { hasChildren: true }), node('共用子頁', '共用根', 1024)] };

/** The sidebar's two trees beside a routed page, as the app shell lays them out. `loadTree` stands for the tree request finishing. */
let loadTree: (nodes: PageNode[]) => void = () => {};
function Sidebar({ initial }: { initial: PageNode[] }) {
  const { pageId } = useParams();
  const [nodes, setNodes] = useState(initial);
  loadTree = setNodes;
  return <><PageTree index={buildTreeIndex(nodes)} currentId={pageId ?? null} dragEnabled={false} onMove={vi.fn()} /><SharedTree shares={[share]} currentId={pageId ?? null} /><Outlet /></>;
}
function open(path: string, nodes: PageNode[] = own) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: '/', element: <Sidebar initial={nodes} />, children: [{ index: true, element: null }, { path: 'p/:pageId', element: null }] }], { initialEntries: [path] });
  render(<MantineProvider env="test"><QueryClientProvider client={client}><UiStateProvider><RouterProvider router={router} /></UiStateProvider></QueryClientProvider></MantineProvider>);
  return { go: (to: string) => act(() => router.navigate(to)), router };
}
const titles = () => screen.getAllByRole('treeitem').map(item => item.querySelector('.tree-row__title')?.textContent);
const row = (title: string) => screen.getAllByRole('treeitem').find(item => item.querySelector('.tree-row__title')?.textContent === title)!;

it('shows the sub-pages of a page when it is opened, one level down', async () => {
  const { go } = open('/');
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
  // Opened from anywhere (a link, search, the address bar): no click on the tree is involved.
  await go('/p/旅行');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
  expect(row('旅行').getAttribute('aria-expanded')).toBe('true');
  expect(row('行程').getAttribute('aria-expanded')).toBe('false');
  await go('/p/行程');
  expect(titles()).toEqual(['旅行', '行程', '第一天', '預算', '筆記', '共用根']);
  // A page without sub-pages opens nothing and is not remembered as expanded.
  await go('/p/筆記');
  expect(titles()).toEqual(['旅行', '行程', '第一天', '預算', '筆記', '共用根']);
  expect(JSON.parse(localStorage.getItem('notes:expanded')!)).toEqual(['旅行', '行程']);
});

it('expands the page that is open when the app starts', () => {
  open('/p/旅行');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
});

it('leaves a page collapsed by hand alone until it is opened again', async () => {
  const { go } = open('/p/旅行');
  fireEvent.click(row('旅行').querySelector('.tree-row__chevron')!);
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
  // Staying on the page (here: the row peek's query string changes) does not open it again.
  await go('/p/旅行?row=1');
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
  await go('/p/筆記');
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
  await go('/p/旅行');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
  // Leaving for a place that is not a page and coming back counts as opening it again.
  fireEvent.click(row('旅行').querySelector('.tree-row__chevron')!);
  await go('/');
  await go('/p/旅行');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
});

it('opens the sub-pages again when the row of the open page is clicked', async () => {
  const { router } = open('/p/旅行');
  fireEvent.click(row('旅行').querySelector('.tree-row__chevron')!);
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
  await act(async () => { fireEvent.click(row('旅行')); });
  expect(router.state.location.pathname).toBe('/p/旅行');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
  await act(async () => { fireEvent.click(row('預算')); });
  expect(decodeURIComponent(router.state.location.pathname)).toBe('/p/預算');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
});

it('does the same for a page somebody else shares', async () => {
  const { go } = open('/');
  await go('/p/共用根');
  expect(titles()).toEqual(['旅行', '筆記', '共用根', '共用子頁']);
  expect(row('旅行').getAttribute('aria-expanded')).toBe('false');
  // Back on one of the user's own pages and then on the shared one again.
  fireEvent.click(row('共用根').querySelector('.tree-row__chevron')!);
  await go('/p/旅行');
  await go('/p/共用根');
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根', '共用子頁']);
});

it('waits for the tree when the page is open before the tree has loaded, and does not reopen on later tree updates', () => {
  open('/p/旅行', []);
  expect(titles()).toEqual(['共用根']);
  act(() => loadTree(own));
  expect(titles()).toEqual(['旅行', '行程', '預算', '筆記', '共用根']);
  fireEvent.click(row('旅行').querySelector('.tree-row__chevron')!);
  act(() => loadTree(own.map(item => ({ ...item, updatedAt: 1 }))));
  expect(titles()).toEqual(['旅行', '筆記', '共用根']);
});
