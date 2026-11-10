// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import type { PageResponse, UserDto } from '../../src/shared/api.ts';
import type { DatabaseProperty, DatabaseRow } from '../../src/shared/database.ts';
import { summarizePage } from '../../src/shared/offline.ts';
import type { OfflineManifest } from '../../src/shared/offline.ts';
import type { IncomingShareDto, PublicPageDto, PublicShareDto, ShareStateDto } from '../../src/shared/shares.ts';
import { UNREACHABLE_PAGE } from '../../src/shared/shares.ts';
import { ShareDialog } from '../../src/client/features/share/ShareDialog.tsx';
import { PublicView } from '../../src/client/features/share/PublicView.tsx';
import { SharedTree } from '../../src/client/features/share/SharedTree.tsx';
import { ListView } from '../../src/client/features/database/CollectionViews.tsx';
import { DatabaseAccessContext } from '../../src/client/features/database/access.ts';
import { UiStateProvider } from '../../src/client/app/uiState.tsx';
import { cachePage, createLocalNote, forgetOfflineData, loadShares, loadTree, offlineNote, rememberUser, saveLocalContent, syncNotes } from '../../src/client/offline/notes.ts';
import { readLocal } from '../../src/client/offline/storage.ts';
import { sharedKey } from '../../src/client/offline/owner.ts';

const uuid = () => crypto.randomUUID();
const reply = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const connectivity = (online: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
let client: QueryClient;
const requests: { method: string; path: string; body?: unknown }[] = [];
/** Routes requests by "METHOD path"; anything unexpected fails the test. */
function serve(routes: (method: string, path: string, body: unknown) => Response | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, body });
    const response = routes(method, path, body);
    if (!response) throw new Error(`unexpected request: ${method} ${path}`);
    return response;
  }));
}
const wrap = (node: React.ReactNode) => <MantineProvider env="test"><QueryClientProvider client={client}>{node}</QueryClientProvider></MantineProvider>;

beforeEach(() => {
  requests.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); client.clear(); Reflect.deleteProperty(document, 'fonts'); vi.unstubAllGlobals(); });

describe('the share dialog', () => {
  const pageId = uuid(), memberId = uuid(), token = 'T'.repeat(43);
  it('switches the public link, sets the scope and manages members', async () => {
    const accountLink = () => screen.getAllByLabelText('知道連結的本站帳號').find(node => node.tagName === 'INPUT')!;
    let state: ShareStateDto = { share: null, inherited: [{ pageId: uuid(), title: '上層', scope: 'all', link: true, members: 2, accountRole: null }] };
    serve((method, path, body) => {
      const share: NonNullable<ShareStateDto['share']> = state.share ?? { pageId, scope: 'page', link: null, members: [], accountRole: null, visitors: [] };
      if (path === `/api/pages/${pageId}/share` && method === 'PUT') state = { ...state, share: { ...share, scope: (body as { scope: 'subpages' }).scope } };
      else if (path === `/api/pages/${pageId}/share/link`) state = { ...state, share: { ...share, link: method === 'POST' ? { token, createdAt: 1 } : null } };
      else if (path === `/api/pages/${pageId}/share/account-link` && method === 'PUT') {
        const role = (body as { role: 'viewer' | 'editor' | null }).role;
        state = { ...state, share: { ...share, accountRole: role, visitors: role ? [{ userId: uuid(), displayName: '訪客帳號' }] : [] } };
      }
      else if (path === `/api/pages/${pageId}/share/members` && method === 'PUT') {
        const input = body as { email: string; role: 'viewer' | 'editor' };
        if (input.email !== 'member@example.test') return reply(404, { error: { code: 'not_found', message: '找不到這個帳號，請確認對方註冊時使用的 email。' } });
        state = { ...state, share: { ...share, members: [{ userId: memberId, email: input.email, displayName: '成員', role: input.role }] } };
      } else if (path === `/api/pages/${pageId}/share/members/${memberId}` && method === 'DELETE') state = { ...state, share: { ...share, members: [] } };
      else if (path === `/api/pages/${pageId}/share` && method === 'DELETE') { state = { ...state, share: null }; return reply(204, null); }
      else if (!(path === `/api/pages/${pageId}/share` && method === 'GET') && path !== '/api/shares' && path !== '/api/pages/tree') return undefined;
      return reply(200, path === '/api/shares' ? { outgoing: [], incoming: [] } : path === '/api/pages/tree' ? { pages: [] } : state);
    });
    render(wrap(<ShareDialog page={{ id: pageId, kind: 'page', title: '筆記' }} onClose={() => {}} />));
    // A share higher up that already reaches this page is pointed out.
    expect(await screen.findByText(/上層.*分享範圍包含這個頁面（公開連結、2 位成員）/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('此頁面與子頁面'));
    await waitFor(() => expect(requests.some(request => request.method === 'PUT' && (request.body as { scope?: string }).scope === 'subpages')).toBe(true));
    fireEvent.click(screen.getByRole('switch', { name: /公開連結/ }));
    expect((await screen.findByLabelText('公開連結網址')).textContent).toBe(`${window.location.origin}/s/${token}`);
    // Opening the page to every signed-in account that has its address: the address is shown, with who has opened it.
    fireEvent.click(accountLink());
    fireEvent.click(await screen.findByRole('option', { name: '知道連結的人皆可編輯' }));
    expect((await screen.findByLabelText('頁面網址')).textContent).toBe(`${window.location.origin}/p/${pageId}`);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', path: `/api/pages/${pageId}/share/account-link`, body: { role: 'editor' } });
    expect(screen.getByText(/目前有 1 個帳號開啟過：訪客帳號/)).toBeTruthy();
    fireEvent.click(accountLink());
    fireEvent.click(await screen.findByRole('option', { name: '不開放' }));
    await waitFor(() => expect(screen.queryByLabelText('頁面網址')).toBeNull());
    expect(requests.at(-1)).toMatchObject({ body: { role: null } });
    // An unknown address is reported and nothing is added.
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nobody@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));
    expect(await screen.findByText(/找不到這個帳號/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'member@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));
    expect(await screen.findByText('member@example.test')).toBeTruthy();
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { email: 'member@example.test', role: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: '移除 成員' }));
    await waitFor(() => expect(screen.queryByText('member@example.test')).toBeNull());
    // Stopping needs a confirmation.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '停止分享' }));
    expect(requests.some(request => request.method === 'DELETE' && request.path === `/api/pages/${pageId}/share`)).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '停止分享' }));
    await waitFor(() => expect(screen.queryByLabelText('公開連結網址')).toBeNull());
    confirm.mockRestore();
  });
});

describe('a public link in the browser', () => {
  const token = 'P'.repeat(43), rootId = uuid(), childId = uuid(), databaseId = uuid(), rowId = uuid(), propertyId = uuid();
  const share: PublicShareDto = { rootId, scope: 'all', tree: [
    { id: rootId, parentId: null, kind: 'page', title: '公開筆記', icon: '📘' }, { id: childId, parentId: rootId, kind: 'page', title: '子頁', icon: null }, { id: databaseId, parentId: rootId, kind: 'database', title: '清單', icon: null }] };
  const root: PublicPageDto = { breadcrumbs: [{ id: rootId, title: '公開筆記', icon: '📘', kind: 'page' }], page: { id: rootId, kind: 'page', databaseId: null, title: '公開筆記', icon: '📘', coverUrl: null, coverPosition: 50, fullWidth: false, updatedAt: 1, content: [
    { id: 'p', type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text: '公開內文 ', styles: {} }, { type: 'pageLink', props: { pageId: childId, title: '舊標題' } }, { type: 'text', text: UNREACHABLE_PAGE, styles: {} }] },
    { id: 'f', type: 'file', props: { url: `/api/public/${token}/files/${uuid()}/note.txt`, name: 'note.txt' }, children: [] }] } };
  const properties: DatabaseProperty[] = [{ id: propertyId, name: '狀態', type: 'text', choices: [], position: 1 }];
  const rows: DatabaseRow[] = [{ id: rowId, databaseId, title: '第一列', icon: null, version: 1, values: { [propertyId]: '進行中' }, updatedAt: 1 }];
  const database: PublicPageDto = { breadcrumbs: [...root.breadcrumbs, { id: databaseId, title: '清單', icon: null, kind: 'database' }],
    page: { ...root.page, id: databaseId, kind: 'database', title: '清單', icon: null, content: [] }, database: { meta: { id: databaseId, version: 1, properties, views: [{ id: uuid(), name: '清單', type: 'list', config: { sorts: [], filters: [] } }] }, rows } };
  const open = (path: string) => {
    serve((method, url) => method !== 'GET' ? undefined : url === `/api/public/${token}` ? reply(200, share) : url === `/api/public/${token}/pages/${rootId}` ? reply(200, root)
      : url === `/api/public/${token}/pages/${databaseId}` ? reply(200, database) : url.startsWith('/api/public/') ? reply(404, { error: { code: 'not_found', message: '找不到頁面。' } }) : undefined);
    const router = createMemoryRouter([{ path: '/s/:token', element: <PublicView /> }, { path: '/s/:token/:pageId', element: <PublicView /> }], { initialEntries: [path] });
    render(wrap(<UiStateProvider><RouterProvider router={router} /></UiStateProvider>));
    return router;
  };

  it('shows the page read-only without ever asking who the visitor is', async () => {
    open(`/s/${token}`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('公開筆記');
    expect(screen.queryByRole('textbox', { name: '頁面標題' })).toBeNull();
    expect(screen.queryByText('新增圖示')).toBeNull();
    await waitFor(() => expect(document.querySelector('.bn-editor')?.textContent).toContain('公開內文'));
    // A link inside the share shows the page's current title and leads to the link's own address.
    const nav = screen.getByRole('navigation', { name: '分享的頁面' });
    expect([...nav.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([`/s/${token}/${rootId}`, `/s/${token}/${childId}`, `/s/${token}/${databaseId}`]);
    expect(document.querySelector('.page-link-chip')?.textContent).toBe('子頁');
    expect(document.querySelector('.bn-editor')?.textContent).toContain(UNREACHABLE_PAGE);
    expect(screen.getByRole('link', { name: /note\.txt/ }).getAttribute('href')).toContain(`/api/public/${token}/files/`);
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    // Only the public endpoints were used: no session check, no page tree, no discussions.
    expect(requests.map(request => request.path)).toEqual([`/api/public/${token}`, `/api/public/${token}/pages/${rootId}`]);
  });

  it('shows a shared database without anything to edit, and rows open inside the link', async () => {
    open(`/s/${token}/${databaseId}`);
    expect((await screen.findByRole('button', { name: '第一列／狀態' })).textContent).toBe('進行中');
    expect(screen.getByRole('button', { name: '第一列／名稱' }).getAttribute('aria-readonly')).toBe('true');
    expect(screen.getByRole('link', { name: '開啟資料列：第一列' }).getAttribute('href')).toBe(`/s/${token}/${rowId}`);
    fireEvent.click(screen.getByRole('button', { name: '第一列／狀態' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /新增/ })).toBeNull();
    expect(requests.every(request => request.path.startsWith('/api/public/') && request.method === 'GET')).toBe(true);
  });

  it('says plainly when the link no longer works', async () => {
    open(`/s/${'x'.repeat(43)}`);
    expect(await screen.findByText('這個連結無法開啟')).toBeTruthy();
    expect(requests.map(request => request.path)).toEqual([`/api/public/${'x'.repeat(43)}`]);
  });
});

describe('what a member sees of a shared database', () => {
  it('shows values only to a reader, and editing without deletion to an editor', () => {
    const databaseId = uuid(), propertyId = uuid();
    const props = { rows: [{ id: uuid(), databaseId, title: '列', icon: null, version: 1, values: { [propertyId]: '值' }, updatedAt: 1 }], properties: [{ id: propertyId, name: '欄', type: 'text' as const, choices: [], position: 1 }],
      config: { sorts: [], filters: [] }, onSave: async () => {}, onCreate: async () => {}, onTrash: () => {}, onReload: () => {}, adding: true, onCloseAdd: () => {} };
    const show = (canEditRows: boolean) => render(<MantineProvider env="test"><MemoryRouter><DatabaseAccessContext.Provider value={{ canEditRows, canManage: false, rowHref: id => `/p/${id}` }}><ListView {...props} /></DatabaseAccessContext.Provider></MemoryRouter></MantineProvider>);
    const reader = show(false);
    fireEvent.click(screen.getByRole('button', { name: '列／欄' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '資料列選單：列' }));
    expect(screen.queryByText('移至垃圾桶')).toBeNull();
    reader.unmount();
    show(true);
    fireEvent.click(screen.getByRole('button', { name: '列／欄' }));
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '資料列選單：列' }));
    expect(screen.queryByText('移至垃圾桶')).toBeNull();
  });
});

describe('shared notes on this device', () => {
  const account: UserDto = { id: uuid(), email: 'member@example.test', username: null, displayName: '成員', role: 'user', createdAt: 0 };
  const access = { role: 'editor' as const, rootId: '', owner: { id: uuid(), name: '擁有者' } };
  const shared = (id = uuid(), title = '共用筆記'): PageResponse => ({ page: { id, parentId: null, kind: 'page', databaseId: null, title, icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 3, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 },
    breadcrumbs: [{ id, title, icon: null, kind: 'page' }], access: { ...access, rootId: id } });
  const incoming = (page: PageResponse): IncomingShareDto => ({ pageId: page.page.id, role: 'editor', scope: 'page', owner: access.owner,
    tree: [{ id: page.page.id, parentId: null, kind: 'page', title: page.page.title, icon: null, position: 1, isFavorite: false, favoritePosition: null, hasChildren: false, updatedAt: 1 }] });
  const pull = async (pages: PageResponse[], list: IncomingShareDto[]) => {
    const manifest: OfflineManifest = { userId: account.id, tree: [], pages: pages.map(summarizePage), maxUploadBytes: 1024, databases: [], annotations: [], shared: list };
    serve((_method, path) => {
      if (path === '/api/auth/me') return reply(200, { user: account, csrfToken: uuid() });
      if (path === '/api/offline/manifest') return reply(200, manifest);
      const found = pages.find(item => path === `/api/pages/${item.page.id}`);
      return found ? reply(200, found) : reply(404, { error: { code: 'not_found', message: '找不到頁面。' } });
    });
    connectivity(true);
    await syncNotes({ force: true });
  };
  beforeEach(async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    connectivity(false);
    await syncNotes(); await forgetOfflineData(); await rememberUser(account);
  });

  it('downloads what is shared, keeps the list for offline use and drops a page once the share ends', async () => {
    const page = shared();
    await pull([page], [incoming(page)]);
    expect((await offlineNote(page.page.id))?.local.access).toEqual(page.access);
    // Without a connection the sidebar still knows what is shared.
    serve(() => { throw new TypeError('offline'); });
    connectivity(false);
    expect(await loadShares()).toEqual({ outgoing: [], incoming: [incoming(page)] });
    // A page under somebody else's cannot be created here: the server would refuse it for ever.
    await expect(createLocalNote({ parentId: page.page.id })).rejects.toThrow('只有擁有者可以在共用的頁面底下新增子頁面');
    // A draft of a shared note waits like any other, but never appears among the user's own pages.
    await saveLocalContent(page.page.id, [{ id: 'b', type: 'paragraph', props: {}, content: [], children: [] }], (await offlineNote(page.page.id))!.revision);
    expect(await loadTree()).toEqual([]);
    // The owner downgrades the member while the draft waits: the device learns the new role and keeps the draft.
    const downgraded = { ...page, access: { ...page.access!, role: 'viewer' as const } };
    const manifest: OfflineManifest = { userId: account.id, tree: [], pages: [summarizePage(downgraded)], maxUploadBytes: 1024, databases: [], annotations: [], shared: [{ ...incoming(page), role: 'viewer' }] };
    serve((method, path) => path === '/api/auth/me' ? reply(200, { user: account, csrfToken: uuid() }) : path === '/api/offline/manifest' ? reply(200, manifest)
      : method === 'PUT' ? reply(403, { error: { code: 'forbidden', message: '這個頁面以唯讀方式與你共用，無法修改。' } }) : reply(200, downgraded));
    connectivity(true);
    await syncNotes({ force: true });
    const kept = await offlineNote(page.page.id);
    expect(kept).toMatchObject({ pending: true, problem: '這個頁面以唯讀方式與你共用，無法修改。', local: { access: { role: 'viewer' } } });
    expect(kept?.local.page.content).toHaveLength(1);
  });

  it('marks a clean copy as gone when the share is withdrawn and forgets the list with the account', async () => {
    const page = shared();
    await pull([page], [incoming(page)]);
    await pull([], []);
    expect(await offlineNote(page.page.id)).toMatchObject({ removed: true, local: { page: { content: [] } } });
    expect(await readLocal(sharedKey(account.id))).toEqual([]);
    await pull([page], [incoming(page)]);
    // Another account signs in on this device: nothing of the first one's shared list stays.
    await rememberUser({ ...account, id: uuid(), email: 'other@example.test' });
    expect(await readLocal(sharedKey(account.id))).toBeUndefined();
    expect(await cachePage(shared()).then(() => true)).toBe(true);
  });
});

describe('the list of what is shared with me', () => {
  it('shows each shared page with its owner and offers only to remove it', async () => {
    const rootId = uuid(), childId = uuid();
    const share: IncomingShareDto = { pageId: rootId, role: 'viewer', scope: 'subpages', owner: { id: uuid(), name: '擁有者' }, tree: [
      { id: rootId, parentId: null, kind: 'page', title: '共用根', icon: null, position: 1, isFavorite: false, favoritePosition: null, hasChildren: true, updatedAt: 1 },
      { id: childId, parentId: rootId, kind: 'page', title: '共用子頁', icon: null, position: 1, isFavorite: false, favoritePosition: null, hasChildren: false, updatedAt: 1 }] };
    serve((method, path) => method === 'DELETE' && path === `/api/shares/incoming/${rootId}` ? reply(204, null) : path === '/api/shares' ? reply(200, { outgoing: [], incoming: [] }) : undefined);
    render(wrap(<UiStateProvider><MemoryRouter><SharedTree shares={[share]} currentId={null} /></MemoryRouter></UiStateProvider>));
    expect(screen.getByRole('treeitem', { name: /共用根/ }).getAttribute('title')).toBe('擁有者 與你共用 · 唯讀');
    expect(screen.queryByText('共用子頁')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展開' }));
    expect(screen.getByText('共用子頁')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '共用選項：共用根' }));
    expect(screen.queryByText('移至垃圾桶')).toBeNull();
    expect(screen.queryByText('新增子頁面')).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(await screen.findByText('移除這項共用'));
    await waitFor(() => expect(requests.some(request => request.method === 'DELETE' && request.path === `/api/shares/incoming/${rootId}`)).toBe(true));
    confirm.mockRestore();
  });
});
