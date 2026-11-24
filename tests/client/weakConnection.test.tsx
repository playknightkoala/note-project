// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageResponse, UserDto } from '../../src/shared/api.ts';
import { AUTH_LOST_EVENT, api } from '../../src/client/api/client.ts';
import { usePage } from '../../src/client/api/pages.ts';
import { RequireAuth } from '../../src/client/features/auth/RequireAuth.tsx';
import { connectionState, watchConnection } from '../../src/client/offline/connection.ts';
import { cachePage, forgetOfflineData, loadNote, offlineNote, rememberUser, revokeOfflineEntry, saveLocalContent, syncNotes, verifySyncSession } from '../../src/client/offline/notes.ts';

const account: UserDto = { id: crypto.randomUUID(), email: 'synthetic@example.test', username: null, displayName: '測試帳號', role: 'user', createdAt: 0 };
const page: PageResponse = {
  page: { id: crypto.randomUUID(), parentId: null, databaseId: null, kind: 'page', version: 1, title: '本機筆記', content: [], createdAt: 0, updatedAt: 0, isFavorite: false, trashedAt: null, icon: null, coverUrl: null, coverPosition: 50, fullWidth: false },
  breadcrumbs: [],
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });
const waitsForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const fakeNetworkTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

let stop: (() => void) | undefined;
beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  online(false);
  await forgetOfflineData();
  await rememberUser(account);
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows an owned copy during a slow read and applies the server result when it arrives', async () => {
  await cachePage(page);
  online(true);
  let respond: (response: Response) => void = () => { throw new Error('尚未送出請求'); };
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => usePage(page.page.id), { wrapper });
  await waitFor(() => expect(result.current.data?.page.title).toBe('本機筆記'));
  expect(result.current.isFetching).toBe(true);
  await act(async () => { respond(reply({ ...page, page: { ...page.page, title: '線上筆記', version: 2 } })); });
  await waitFor(() => expect(result.current.data?.page.title).toBe('線上筆記'));
});

it('withholds a cached shared page on timeout or confirmed revocation and retains its draft for export', async () => {
  const access = { rootId: page.page.id, role: 'editor' as const, owner: { id: crypto.randomUUID(), name: '擁有者' } };
  const cached = await cachePage({ ...page, access });
  await saveLocalContent(page.page.id, [{ draft: true }], cached.localRevision);
  online(true);
  vi.stubGlobal('fetch', vi.fn((_path, { signal }) => waitsForAbort(signal)));
  fakeNetworkTimers();
  const publish = vi.fn();
  const pending = expect(loadNote(page.page.id, { signal: new AbortController().signal, publish })).rejects.toMatchObject({ status: 0, message: expect.stringContaining('共用頁面') });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(publish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3_000);
  await pending;
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => reply({}, 404)));
  await expect(loadNote(page.page.id)).rejects.toMatchObject({ status: 404 });
  expect(await offlineNote(page.page.id)).toMatchObject({ removed: true, pending: true, local: { page: { content: [{ draft: true }] } } });
  online(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await expect(loadNote(page.page.id)).rejects.toMatchObject({ status: 404 });
});

it('waits for three consecutive probes and a fresh session before sending drafts', async () => {
  const cached = await cachePage(page);
  await saveLocalContent(page.page.id, [{ draft: true }], cached.localRevision);
  online(true);
  fakeNetworkTimers();
  let healthy = false;
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/healthz') return new Response(healthy ? 'ok\n' : 'unavailable', { status: healthy ? 200 : 503 });
    if (path === '/api/auth/me') return reply({ user: account, csrfToken: crypto.randomUUID() });
    if (path === `/api/offline/pages/${page.page.id}`) {
      return reply({ ...page, page: { ...page.page, content: JSON.parse(String(init?.body)).content, version: 2 } });
    }
    if (path === '/api/offline/manifest') return reply({ userId: account.id, pages: [], tree: [], databases: [], annotations: [] });
    return waitsForAbort(init!.signal!);
  });
  vi.stubGlobal('fetch', fetcher);
  const verify = vi.fn(verifySyncSession);
  stop = watchConnection(verify);
  const requests = Promise.allSettled([api('GET', '/api/pages/tree'), api('GET', `/api/pages/${page.page.id}`)]);
  await vi.advanceTimersByTimeAsync(3_000);
  await requests;
  expect(connectionState()).toBe('unstable');
  expect(fetcher).toHaveBeenCalledWith('/healthz', expect.objectContaining({ credentials: 'omit', cache: 'no-store', redirect: 'error' }));
  await syncNotes({ force: true });
  expect(fetcher.mock.calls.some(([path]) => path === '/api/auth/me' || path.startsWith('/api/offline/'))).toBe(false);
  healthy = true;
  await vi.advanceTimersByTimeAsync(7_000);
  expect(verify).not.toHaveBeenCalled();
  expect(connectionState()).toBe('unstable');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(verify).toHaveBeenCalledOnce();
  expect(connectionState()).toBe('online');
  await syncNotes({ force: true });
  expect(fetcher.mock.calls.map(([path]) => path).slice(-4)).toEqual(['/api/auth/me', '/api/auth/me', `/api/offline/pages/${page.page.id}`, '/api/offline/manifest']);
  expect(await offlineNote(page.page.id)).toMatchObject({ pending: false });
});

it('recognizes a 401 even if its body stalls and keeps already saved edits', async () => {
  const cached = await cachePage(page);
  await saveLocalContent(page.page.id, [{ draft: true }], cached.localRevision);
  online(true);
  fakeNetworkTimers();
  const expired = vi.fn(revokeOfflineEntry);
  window.addEventListener(AUTH_LOST_EVENT, expired);
  try {
    vi.stubGlobal('fetch', vi.fn(async (_path, { signal }) => ({ status: 401, ok: false, text: () => waitsForAbort(signal) })));
    const rejected = expect(verifySyncSession()).rejects.toMatchObject({ status: 401 });
    await vi.advanceTimersByTimeAsync(0);
    expect(expired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    await Promise.all(expired.mock.results.map(result => result.value));
    expect(await offlineNote(page.page.id)).toBeUndefined();
    await rememberUser(account);
    expect(await offlineNote(page.page.id)).toMatchObject({ pending: true });
  } finally {
    window.removeEventListener(AUTH_LOST_EVENT, expired);
  }
});

it('redirects an open private route after the server rejects the recovered session', async () => {
  online(true);
  const fetcher = vi.fn(async () => reply({ user: account, csrfToken: crypto.randomUUID() }));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient();
  client.setQueryData(['me'], account);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/p/note']}><Routes>
    <Route path="/p/note" element={<RequireAuth><p>編輯中的筆記</p></RequireAuth>} />
    <Route path="/login" element={<p>登入頁面</p>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText('編輯中的筆記')).toBeTruthy();
  fetcher.mockResolvedValueOnce(reply({}, 401));
  await act(async () => { await expect(verifySyncSession()).rejects.toMatchObject({ status: 401 }); });
  await screen.findByText('登入頁面');
  expect(screen.queryByText('編輯中的筆記')).toBeNull();
});
