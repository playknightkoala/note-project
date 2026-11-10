// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DatabaseView } from '../../src/client/features/database/DatabaseView.tsx';
import type { DatabaseDto, DatabaseRow } from '../../src/shared/database.ts';
import type { OfflineOp } from '../../src/shared/offline.ts';
import { forgetOfflineData, offlineNote, rememberUser, syncNotes } from '../../src/client/offline/notes.ts';
import { queuedOps, storeDatabase } from '../../src/client/offline/outbox.ts';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('switches shared data between views and persists creating, renaming, independent column settings and deleting views through the real API hooks', async () => {
  const id = crypto.randomUUID(); const groupId = crypto.randomUUID(); const choice = crypto.randomUUID();
  const tableId = crypto.randomUUID(); const listId = crypto.randomUUID(); const boardId = crypto.randomUUID();
  let meta: DatabaseDto = { id, version: 1, properties: [{ id: groupId, name: '狀態', type: 'select', position: 1, choices: [{ id: choice, label: '進行中', color: 'blue' }] }], views: [
    { id: tableId, name: '表格', type: 'table', config: { sorts: [], filters: [] } },
    { id: listId, name: '清單', type: 'list', config: { sorts: [], filters: [] } },
    { id: boardId, name: '看板', type: 'board', config: { sorts: [], filters: [], groupBy: groupId } },
  ] };
  let row: DatabaseRow = { id: crypto.randomUUID(), databaseId: id, title: '整合任務', icon: null, version: 1, values: {}, updatedAt: 0 };
  const requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const path = input.split('?')[0]!; const method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path, headers: init.headers as Record<string, string>, body });
    if (method === 'GET' && path === `/api/databases/${id}`) return Response.json(meta);
    if (method === 'GET' && path.endsWith('/rows')) return Response.json({ rows: [row], total: 1, offset: 0, limit: 100 });
    // Every change is one repeatable operation; the ids of new things are chosen by the client.
    if (method !== 'POST' || path !== '/api/offline/ops') throw new Error(`Unexpected test request: ${method} ${path}`);
    const { op } = body as { op: OfflineOp };
    if (op.type === 'row.update') { row = { ...row, title: op.title?.value ?? row.title, version: row.version + 1 }; return Response.json({ row }); }
    if (op.type === 'view.update') meta = { ...meta, version: meta.version + 1, views: meta.views.map(view => view.id === op.viewId ? { ...view, ...op.input } as DatabaseDto['views'][number] : view) };
    else if (op.type === 'view.add') meta = { ...meta, version: meta.version + 1, views: [...meta.views, { ...op.input, id: op.viewId, type: op.input.type ?? 'table' }] };
    else if (op.type === 'view.delete') meta = { ...meta, version: meta.version + 1, views: meta.views.filter(view => view.id !== op.viewId) };
    else throw new Error(`Unexpected test operation: ${op.type}`);
    return Response.json({ database: meta });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider env="test"><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${id}?view=${listId}`]}><DatabaseView databaseId={id} /></MemoryRouter></QueryClientProvider></MantineProvider>);
  const list = await screen.findByRole('tab', { name: '清單' });
  expect(list.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(await screen.findByRole('button', { name: '整合任務／名稱' }));
  fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '共用改名' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('名稱')); });
  await screen.findByRole('button', { name: '共用改名／名稱' });
  // The change carries the title the cell showed, so only a rename made elsewhere meanwhile would conflict.
  expect((requests.find(request => request.method === 'POST')?.body as { op: OfflineOp }).op).toMatchObject({ type: 'row.update', databaseId: id, rowId: row.id, title: { base: '整合任務', value: '共用改名' } });
  fireEvent.click(screen.getByRole('tab', { name: '看板' }));
  expect(await screen.findByLabelText('資料庫看板')).toBeTruthy();
  expect(screen.getByRole('button', { name: '共用改名／名稱' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '顯示欄位' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '狀態' }));
  fireEvent.click(screen.getByRole('button', { name: '顯示欄位' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存視圖' })); });
  await waitFor(() => expect(meta.views[2]!.config.columns).toEqual([]));
  expect(meta.views[2]!.config.groupBy).toBe(groupId);
  expect(meta.views[1]!.config.columns).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '編輯視圖' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: /視圖名稱/ }), { target: { value: '工作進度' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '儲存視圖' })); });
  await screen.findByRole('tab', { name: '工作進度' });
  fireEvent.click(screen.getByRole('button', { name: '新增視圖' }));
  const addDialog = await screen.findByRole('dialog');
  fireEvent.change(within(addDialog).getByRole('textbox', { name: /視圖名稱/ }), { target: { value: '第二個清單' } });
  await act(async () => { fireEvent.click(within(addDialog).getByRole('button', { name: '儲存視圖' })); });
  await waitFor(() => expect(screen.getByRole('tab', { name: '第二個清單' }).getAttribute('aria-selected')).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: '編輯視圖' }));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '刪除視圖' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '確認刪除視圖' })); });
  await waitFor(() => expect(screen.queryByRole('tab', { name: '第二個清單' })).toBeNull());
  expect(screen.getByRole('tab', { name: '表格' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('tab', { name: '表格' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '清單' }).getAttribute('aria-selected')).toBe('true');
  await screen.findByRole('button', { name: '共用改名／名稱' });
  expect(row.title).toBe('共用改名');
  client.clear();
});

it('opens a database from the copy on this device when offline, and keeps edits, new rows and new columns there until they can be synced', async () => {
  const account = { id: crypto.randomUUID(), email: 'synthetic@example.test', username: null, displayName: '離線', role: 'user' as const, createdAt: 0 };
  vi.stubGlobal('BroadcastChannel', undefined);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await syncNotes(); await forgetOfflineData(); await rememberUser(account);
  const id = crypto.randomUUID(), textId = crypto.randomUUID(), rowId = crypto.randomUUID();
  await storeDatabase(account.id, { stamp: 's1',
    meta: { id, version: 4, properties: [{ id: textId, name: '摘要', type: 'text', position: 1024, choices: [] }], views: [{ id: crypto.randomUUID(), name: '清單', type: 'list', config: { sorts: [{ propertyId: 'title', direction: 'asc' }], filters: [] } }] },
    rows: [{ id: rowId, databaseId: id, title: 'B列', icon: null, version: 1, values: { [textId]: '下載的值' }, updatedAt: 0 }, { id: crypto.randomUUID(), databaseId: id, title: 'A列', icon: null, version: 1, values: {}, updatedAt: 0 }] });
  const fetcher = vi.fn(async (_path: string, _init?: RequestInit): Promise<Response> => { throw new TypeError('offline'); });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider env="test"><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${id}`]}><DatabaseView databaseId={id} /></MemoryRouter></QueryClientProvider></MantineProvider>);
  await screen.findByText(/目前顯示此裝置上的副本/);
  // The saved view's sort is applied on the device: stored as B, A and shown ascending.
  const titles = () => screen.getAllByRole('button').map(cell => cell.getAttribute('aria-label')).filter(label => label?.endsWith('／名稱'));
  await waitFor(() => expect(titles()).toEqual(['A列／名稱', 'B列／名稱']));
  fireEvent.click(screen.getByRole('button', { name: 'B列／摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '離線改的值' } });
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('摘要'), { key: 'Enter' }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'B列／摘要' }).textContent).toBe('離線改的值'));
  fireEvent.click(screen.getByRole('button', { name: '新增' }));
  fireEvent.change(screen.getByLabelText('新資料列名稱'), { target: { value: 'C列' } });
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('新資料列名稱'), { key: 'Enter' }); });
  await waitFor(() => expect(titles()).toEqual(['A列／名稱', 'B列／名稱', 'C列／名稱']));
  fireEvent.click(screen.getByRole('button', { name: '新增屬性' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: /欄位名稱/ }), { target: { value: '備註' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '儲存欄位' })); });
  await screen.findByRole('button', { name: 'B列／備註' });
  // Nothing reached the server; everything waits, in order, with the values the cells showed when edited.
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  const queue = (await queuedOps()).map(item => item.op);
  expect(queue).toMatchObject([
    { type: 'row.update', databaseId: id, rowId, values: { [textId]: { base: '下載的值', value: '離線改的值' } } },
    { type: 'row.create', databaseId: id, title: 'C列' },
    { type: 'property.add', databaseId: id, baseVersion: 4, input: { name: '備註', type: 'text' } },
  ]);
  // The row made here can be opened as a page before the server knows it.
  const created = queue[1] as Extract<OfflineOp, { type: 'row.create' }>;
  expect(await offlineNote(created.rowId)).toMatchObject({ localOnly: true, local: { page: { kind: 'row', databaseId: id, title: 'C列', version: 1 } } });
  client.clear();
  await forgetOfflineData().catch(() => {});
});
