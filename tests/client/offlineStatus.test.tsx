// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineStatus } from '../../src/client/offline/OfflineStatus.tsx';
import { forgetOfflineData, rememberUser, syncNotes } from '../../src/client/offline/notes.ts';

const account = { id: crypto.randomUUID(), email: 'synthetic@example.test', username: null, displayName: '測試', role: 'user' as const, createdAt: 0 };
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function mount() {
  return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><MantineProvider env="test"><OfflineStatus /></MantineProvider></MemoryRouter></QueryClientProvider>);
}
beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  await syncNotes(); await forgetOfflineData(); await rememberUser(account);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(async () => { cleanup(); await syncNotes(); vi.unstubAllGlobals(); });

it('shows progress until both directions finish, then announces completion with a timestamp', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/auth/me'
    ? reply({ user: account, csrfToken: crypto.randomUUID() })
    : new Promise<Response>(resolve => { release = resolve; })));
  mount();
  await screen.findByText('正在同步離線筆記…');
  expect(screen.queryByText('離線筆記已同步完成')).toBeNull();
  await act(async () => { release(reply({ userId: account.id, tree: [], pages: [], maxUploadBytes: 90 * 1024 * 1024 })); await syncNotes(); });
  await screen.findByText('離線筆記已同步完成');
  expect(screen.getByText(/最近完整同步：/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '離線與同步' }));
  await screen.findByText(/伺服器目前的附件上傳上限為 90 MB/);
  expect(screen.getByLabelText('此裝置的附件離線快取上限（MB）')).toBeTruthy();
});

it('does not claim completion when the server cannot be reached', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unavailable'); }));
  mount();
  await screen.findByText('同步尚未完成');
  expect(screen.queryByText('離線筆記已同步完成')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '離線與同步' }));
  await waitFor(() => expect(screen.getByText(/無法連線到伺服器/)).toBeTruthy());
});
