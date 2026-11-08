// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAutosave } from '../../src/client/features/page/useAutosave.ts';
import { fetchHead, saveContent } from '../../src/client/api/pages.ts';

vi.mock('../../src/client/api/pages.ts', () => ({ fetchHead: vi.fn(), saveContent: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it('uses each returned version for subsequent saves', async () => {
  vi.mocked(saveContent).mockResolvedValueOnce({ version: 4, updatedAt: 0, title: '' }).mockResolvedValueOnce({ version: 5, updatedAt: 0, title: '' });
  const { result } = renderHook(() => useAutosave({ pageId: 'p', initialVersion: 3, getContent: () => [], onRemoteUpdate: vi.fn() }));
  act(() => result.current.markDirty());
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  act(() => result.current.markDirty());
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(vi.mocked(saveContent).mock.calls.map(call => call[1])).toEqual([3, 4]);
  expect(result.current.state).toMatchObject({ status: 'clean', version: 5 });
});

it('keeps the old If-Match during a remote reload so a local draft cannot silently overwrite newer content', async () => {
  vi.mocked(fetchHead).mockResolvedValue({ version: 9, updatedAt: 0, title: '' });
  vi.mocked(saveContent).mockResolvedValue({ version: 4, updatedAt: 0, title: '' });
  const remote = vi.fn();
  const { result } = renderHook(() => useAutosave({ pageId: 'p', initialVersion: 3, getContent: () => [], onRemoteUpdate: remote }));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(remote).toHaveBeenCalledOnce();
  act(() => result.current.markDirty());
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(vi.mocked(saveContent).mock.calls[0]?.[1]).toBe(3);
});
