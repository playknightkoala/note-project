// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DatabaseView } from '../../src/client/features/database/DatabaseView.tsx';
import type { DatabaseDto, DatabaseRow, ViewInput } from '../../src/shared/database.ts';

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
    if (method === 'PATCH' && path === `/api/rows/${row.id}/values`) { row = { ...row, ...body, version: row.version + 1 }; return Response.json(row); }
    const viewId = path.split('/').at(-1)!;
    if (method === 'PATCH' && path.includes('/views/')) meta = { ...meta, version: meta.version + 1, views: meta.views.map(view => view.id === viewId ? { ...view, ...body } : view) };
    else if (method === 'POST' && path.endsWith('/views')) { const view = body as ViewInput; meta = { ...meta, version: meta.version + 1, views: [...meta.views, { ...view, id: crypto.randomUUID(), type: view.type ?? 'table' }] }; }
    else if (method === 'DELETE' && path.includes('/views/')) meta = { ...meta, version: meta.version + 1, views: meta.views.filter(view => view.id !== viewId) };
    else throw new Error(`Unexpected test request: ${method} ${path}`);
    return Response.json(meta);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MantineProvider env="test"><QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${id}?view=${listId}`]}><DatabaseView databaseId={id} /></MemoryRouter></QueryClientProvider></MantineProvider>);
  const list = await screen.findByRole('tab', { name: '清單' });
  expect(list.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(await screen.findByRole('button', { name: '整合任務／名稱' }));
  fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '共用改名' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('名稱')); });
  await screen.findByRole('button', { name: '共用改名／名稱' });
  expect(requests.find(request => request.method === 'PATCH')?.headers['if-match']).toBe('"1"');
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
