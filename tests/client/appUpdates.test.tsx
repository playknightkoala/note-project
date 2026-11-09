// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppUpdates } from '../../src/client/updates/AppUpdates.tsx';
import { useUpdateGuard } from '../../src/client/updates/guards.ts';
import { activateAppUpdate } from '../../src/client/updates/activate.ts';
import { api } from '../../src/client/api/client.ts';

vi.mock('../../src/client/api/client.ts', async original => ({ ...await original<object>(), api: vi.fn() }));
vi.mock('../../src/client/updates/activate.ts', () => ({ activateAppUpdate: vi.fn() }));
vi.mock('../../src/client/updates/version.ts', () => ({ APP_VERSION: '1.0.7' }));
let client: QueryClient;
const next = { version: '1.0.8', releases: [{ version: '1.0.8', title: '新版測試', changes: ['新增驗收功能'] }] };
function Guard({ dirty }: { dirty: boolean }) { useUpdateGuard(() => { if (dirty) throw new Error('尚有未送出的內容'); }); return <textarea aria-label="草稿" />; }
function mount(dirty = false) {
  const view = (dirty: boolean) => <MantineProvider env="test"><QueryClientProvider client={client}><Guard dirty={dirty} /><AppUpdates /></QueryClientProvider></MantineProvider>;
  const result = render(view(dirty));
  return { ...result, setDirty: (dirty: boolean) => result.rerender(view(dirty)) };
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api).mockResolvedValue(next); vi.mocked(activateAppUpdate).mockResolvedValue();
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('labels the running interface version and automatically shows release information for a newer version', async () => {
  mount();
  expect(screen.getByRole('button', { name: '目前版本 1.0.7，檢查更新' })).toBeTruthy();
  await screen.findByRole('dialog', { name: '有新版本可更新' });
  expect(screen.getByText('新增驗收功能')).toBeTruthy();
  expect(screen.getByText('v1.0.7')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(activateAppUpdate).toHaveBeenCalledWith('1.0.8'));
  expect(api).toHaveBeenCalledWith('GET', '/api/version', expect.objectContaining({ cache: 'no-store' }));
});

it('blocks reload for an unsent draft and allows updating after the user finishes it', async () => {
  const view = mount(true);
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
  await screen.findByText('尚有未送出的內容');
  expect(activateAppUpdate).not.toHaveBeenCalled();
  view.setDirty(false);
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(activateAppUpdate).toHaveBeenCalledWith('1.0.8'));
});

it('can postpone and reopen the reminder, without repeatedly interrupting for the same version', async () => {
  mount(); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: '稍後更新' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => { await client.invalidateQueries({ queryKey: ['app-version'] }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '目前版本 1.0.7，檢查更新' }));
  await screen.findByRole('dialog');
});

it('waits for IME composition to finish before opening the update modal', async () => {
  let release!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  mount();
  fireEvent.compositionStart(screen.getByLabelText('草稿'));
  await act(async () => { release(next); });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.compositionEnd(screen.getByLabelText('草稿'));
  await screen.findByRole('dialog');
});

it('does not prompt for the current version or a server rollback', async () => {
  vi.mocked(api).mockResolvedValue({ version: '1.0.6' });
  mount();
  await waitFor(() => expect(api).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: '目前版本 1.0.7，檢查更新' }));
  await screen.findByText('目前已是最新版本。');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('reports update activation errors and leaves the page available for retry', async () => {
  vi.mocked(activateAppUpdate).mockRejectedValue(new Error('新版下載失敗'));
  mount(); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: '立即更新' }));
  await screen.findByText('新版下載失敗');
  expect(screen.getByRole('button', { name: '立即更新' }).hasAttribute('disabled')).toBe(false);
});
