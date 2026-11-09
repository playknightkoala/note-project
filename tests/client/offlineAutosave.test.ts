// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageResponse } from '../../src/shared/api.ts';
import { useAutosave } from '../../src/client/features/page/useAutosave.ts';
import { cachePage, offlineNote, rememberUser, syncNotes } from '../../src/client/offline/notes.ts';
import type { OfflineNote } from '../../src/client/offline/notes.ts';
import { clearLocal, updateLocal } from '../../src/client/offline/storage.ts';

const userId = crypto.randomUUID();
const response: PageResponse = { page: { id: crypto.randomUUID(), parentId: null, kind: 'page', databaseId: null, title: '標題', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 4, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 }, breadcrumbs: [] };
beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await syncNotes(); await clearLocal();
  await rememberUser({ id: userId, displayName: '測試', email: 'synthetic@example.test', username: null, role: 'user', createdAt: 0 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reports local persistence before server sync, and saves real editor content to IndexedDB', async () => {
  const initial = await cachePage(response);
  const content = [{ id: 'block', type: 'paragraph', content: ['離線文字'] }];
  const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => content, onRemoteUpdate: vi.fn() }));
  await act(async () => { result.current.markDirty(); await result.current.saveNow(); });
  expect(result.current.state.status).toBe('local');
  expect((await offlineNote(response.page.id))?.local.page.content).toEqual(content);
});

it('loading a competing tab draft does not discard that tab’s unsynced content', async () => {
  const initial = await cachePage(response);
  const reload = vi.fn();
  const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [{ own: true }], onRemoteUpdate: reload }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  act(() => result.current.markDirty());
  await act(async () => {
    await updateLocal<OfflineNote>(`page:${userId}:${response.page.id}`, current => ({ ...current!, writer: 'other-tab', revision: 'competing', pending: true, local: { ...current!.local, page: { ...current!.local.page, content: [{ other: true }] } } }));
  });
  await waitFor(() => expect(result.current.state.status).toBe('conflict'));
  await act(async () => { await result.current.resolveConflict('reload'); });
  expect(reload).toHaveBeenCalledOnce();
  expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, revision: 'competing', local: { page: { content: [{ other: true }] } } });
});
