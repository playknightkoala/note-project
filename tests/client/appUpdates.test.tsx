// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const UPDATE = '有新版本，請更新', LOG = '更新紀錄', VERSION_BUTTON = '目前版本 1.0.7，查看更新紀錄';
/** `saved` stands for a note that is written when an update asks; `dirty` for a form only the user can finish. */
const saved = vi.fn();
function Guard({ dirty }: { dirty: boolean }) { useUpdateGuard(() => { if (dirty) throw new Error('尚有未送出的內容。'); saved(); }); return <textarea aria-label="草稿" />; }
function mount(dirty = false) {
  const view = (dirty: boolean) => <MantineProvider env="test"><QueryClientProvider client={client}><Guard dirty={dirty} /><AppUpdates /></QueryClientProvider></MantineProvider>;
  const result = render(view(dirty));
  return { ...result, setDirty: (dirty: boolean) => result.rerender(view(dirty)) };
}
const updateDialog = () => screen.findByRole('dialog', { name: UPDATE }, { timeout: 4000 });
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api).mockResolvedValue(next); vi.mocked(activateAppUpdate).mockResolvedValue();
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('saves what is open first, then shows the update window with the release information', async () => {
  mount();
  expect(screen.getByRole('button', { name: VERSION_BUTTON })).toBeTruthy();
  expect(saved).not.toHaveBeenCalled();
  const dialog = await updateDialog();
  expect(saved).toHaveBeenCalled();
  expect(within(dialog).getByText('新增驗收功能')).toBeTruthy();
  expect(within(dialog).getByText('目前版本 v1.0.7，最新版本 v1.0.8。')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(activateAppUpdate).toHaveBeenCalledWith('1.0.8'));
  expect(api).toHaveBeenCalledWith('GET', '/api/version', expect.objectContaining({ cache: 'no-store' }));
});

it('offers no way to put the update off', async () => {
  mount();
  const dialog = await updateDialog();
  expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['立即更新']);
  expect(screen.queryByRole('button', { name: '稍後更新' })).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  await act(async () => { await client.invalidateQueries({ queryKey: ['app-version'] }); });
  expect(screen.getByRole('dialog', { name: UPDATE })).toBeTruthy();
  expect(activateAppUpdate).not.toHaveBeenCalled();
});

it('waits with the window while something only the user can finish is open, and says why in the update log', async () => {
  const view = mount(true);
  await waitFor(() => expect(screen.getByText('有新版')).toBeTruthy());
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: VERSION_BUTTON }));
  const log = await screen.findByRole('dialog', { name: LOG });
  await within(log).findByText('尚有未送出的內容。完成後會自動出現更新視窗。');
  expect(within(log).getByText('有新版本 v1.0.8')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: UPDATE })).toBeNull();
  view.setDirty(false);
  const dialog = await updateDialog();
  // The log steps aside for the update.
  await waitFor(() => expect(screen.queryByRole('dialog', { name: LOG })).toBeNull());
  fireEvent.click(within(dialog).getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(activateAppUpdate).toHaveBeenCalledWith('1.0.8'));
});

it('steps back when something became unsaved after the window opened, and returns once it is finished', async () => {
  const view = mount();
  const dialog = await updateDialog();
  view.setDirty(true);
  fireEvent.click(within(dialog).getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: UPDATE })).toBeNull());
  expect(activateAppUpdate).not.toHaveBeenCalled();
  view.setDirty(false);
  fireEvent.click(within(await updateDialog()).getByRole('button', { name: '立即更新' }));
  await waitFor(() => expect(activateAppUpdate).toHaveBeenCalledWith('1.0.8'));
});

it('waits for IME composition to finish before saving and opening the update window', async () => {
  let release!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  mount();
  fireEvent.compositionStart(screen.getByLabelText('草稿'));
  await act(async () => { release(next); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(saved).not.toHaveBeenCalled();
  fireEvent.compositionEnd(screen.getByLabelText('草稿'));
  await updateDialog();
});

it('steps aside without a connection and returns with it', async () => {
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  mount();
  await updateDialog();
  onLine.mockReturnValue(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: UPDATE })).toBeNull());
  onLine.mockReturnValue(true);
  act(() => { window.dispatchEvent(new Event('online')); });
  await updateDialog();
});

it('shows the update log of this interface from the version label, without asking to update', async () => {
  vi.mocked(api).mockResolvedValue({ version: '1.0.6' });
  mount();
  await waitFor(() => expect(api).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: VERSION_BUTTON }));
  const log = await screen.findByRole('dialog', { name: LOG });
  // Its own version and the ones before it; nothing this interface does not have yet.
  expect(within(log).getByText('v1.0.7 · 資安強化與保存可靠性修正')).toBeTruthy();
  expect(within(log).getByText('目前版本')).toBeTruthy();
  expect(within(log).getByText('v1.0.6 · 留言修正、版號與立即更新')).toBeTruthy();
  expect(within(log).getByText('可刪除整則討論，保留筆記文字與格式。')).toBeTruthy();
  expect(within(log).queryByText(/^v1\.0\.8/)).toBeNull();
  expect(within(log).queryByText(/有新版本/)).toBeNull();
  expect(screen.queryByRole('dialog', { name: UPDATE })).toBeNull();
  expect(saved).not.toHaveBeenCalled();
  fireEvent.click(within(log).getByRole('button'));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: LOG })).toBeNull());
});

it('shows the update log without a connection to the server', async () => {
  vi.mocked(api).mockRejectedValue(new Error('offline'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: VERSION_BUTTON }));
  const log = await screen.findByRole('dialog', { name: LOG });
  expect(within(log).getByText('v1.0.7 · 資安強化與保存可靠性修正')).toBeTruthy();
});

it('reports update activation errors and leaves the button available for retry', async () => {
  vi.mocked(activateAppUpdate).mockRejectedValue(new Error('新版下載失敗'));
  mount();
  const dialog = await updateDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: '立即更新' }));
  await within(dialog).findByText('新版下載失敗');
  expect(within(dialog).getByRole('button', { name: '立即更新' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('dialog', { name: UPDATE })).toBeTruthy();
});
