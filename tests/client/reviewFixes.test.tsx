// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageKind, PageResponse, UserDto } from '../../src/shared/api.ts';
import { safeNext } from '../../src/client/features/auth/safeNext.ts';
import { PageTitle } from '../../src/client/features/page/PageTitle.tsx';
import { useAutosave } from '../../src/client/features/page/useAutosave.ts';
import { cachePage, forgetOfflineData, offlineNote, offlineNotes, rememberUser, revokeOfflineEntry, saveLocalContent, syncNotes } from '../../src/client/offline/notes.ts';
import type { OfflineNote } from '../../src/client/offline/notes.ts';
import { clearLocal, readLocal, updateLocal } from '../../src/client/offline/storage.ts';

const account = (name: string): UserDto => ({ id: crypto.randomUUID(), displayName: name, email: `${name}@example.test`, username: null, role: 'user', createdAt: 0 });
const me = account('owner');
const pageOf = (kind: PageKind = 'page', version = 4): PageResponse => ({
  page: { id: crypto.randomUUID(), parentId: null, kind, databaseId: kind === 'row' ? crypto.randomUUID() : null, title: '標題', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 },
  breadcrumbs: [],
});
const key = (userId: string, pageId: string) => `page:${userId}:${pageId}`;
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value });
const tick = (ms = 30) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

/** Minimal API double: answers by method and path, records every request. */
function stubApi(answer: (method: string, path: string, body: unknown) => { status?: number; json: unknown } | undefined) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method, path, body });
    const reply = answer(method, path, body) ?? { status: 404, json: { error: { code: 'not_found', message: '找不到資料。' } } };
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }));
  return calls;
}

beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  online(false);
  await syncNotes(); await clearLocal();
  await rememberUser(me);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });

describe('autosave while an IME composition is open', () => {
  const typed = [{ id: 'b', type: 'paragraph', content: ['注音輸入中的文字'] }];
  const composingEditor = () => (force?: boolean) => force ? typed : null;

  it('saves what was typed when the page is left mid-composition', async () => {
    const response = pageOf(), initial = await cachePage(response);
    const { result, unmount } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: composingEditor(), onRemoteUpdate: vi.fn() }));
    act(() => result.current.markComposing());
    unmount();
    await waitFor(async () => expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, local: { page: { content: typed } } }));
  });

  it('saves when the tab is hidden mid-composition', async () => {
    const response = pageOf(), initial = await cachePage(response);
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: composingEditor(), onRemoteUpdate: vi.fn() }));
    act(() => result.current.markComposing());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(async () => expect((await offlineNote(response.page.id))?.local.page.content).toEqual(typed));
  });

  it('does not let continuous composition postpone the save beyond the maximum wait', async () => {
    const response = pageOf(), initial = await cachePage(response), clock = { at: 1_000 };
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: composingEditor(), onRemoteUpdate: vi.fn(), now: () => clock.at }));
    act(() => result.current.markComposing());
    await tick(900);
    expect((await offlineNote(response.page.id))?.pending).toBe(false);
    clock.at += 6_000;
    await waitFor(async () => expect((await offlineNote(response.page.id))?.local.page.content).toEqual(typed), { timeout: 2_000 });
  });
});

describe('autosave on database row pages', () => {
  it('does not mistake its own save, or unrelated local writes, for a remote update', async () => {
    const response = pageOf('row'), initial = await cachePage(response);
    const calls = stubApi((method, path) => method === 'PUT' && path === `/api/pages/${response.page.id}/content` ? { json: { version: 5, updatedAt: 2, title: '標題' } } : undefined);
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [{ id: 'row-body' }], onRemoteUpdate: reload }));
    await act(async () => { result.current.markDirty(); await result.current.saveNow(); });
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(result.current.state).toMatchObject({ status: 'clean', version: 5 });
    // Any write to the local store (the sync loop does one a minute) notifies every open editor.
    await act(async () => { await updateLocal(`tree:${me.id}`, () => []); });
    await tick();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ status: 'clean', version: 5 });
    act(() => result.current.markDirty());
    await act(async () => { await updateLocal(`tree:${me.id}`, () => []); });
    await tick();
    expect(result.current.state.status).toBe('dirty');
    expect(result.current.version()).toBe(5);
  });
});

describe('edits made while a conflict is unresolved', () => {
  const draft = [{ id: 'b', type: 'paragraph', content: ['衝突後繼續輸入'] }];
  async function conflicted(kind: PageKind) {
    const response = pageOf(kind), initial = await cachePage(response);
    const hook = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => draft, onRemoteUpdate: vi.fn() }));
    await tick();
    return { response, ...hook };
  }

  it('keeps an ordinary note’s draft on the device, also when the page is left right away', async () => {
    const { response, result, unmount } = await conflicted('page');
    await act(async () => { await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, pending: true, problem: '此頁面已在其他地方更新。', conflict: { version: 9, updatedAt: 3, title: '標題' } })); });
    await waitFor(() => expect(result.current.state.status).toBe('conflict'));
    act(() => result.current.markDirty());
    expect(result.current.unsavedConflict()).toBe(true);
    unmount();
    await waitFor(async () => expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, problem: '此頁面已在其他地方更新。', local: { page: { content: draft } } }));
  });

  it('reports that a row’s edits cannot be stored, so leaving can be confirmed first', async () => {
    const { response, result } = await conflicted('row');
    stubApi((method, path) => method === 'PUT' && path.endsWith('/content') ? { status: 409, json: { error: { code: 'version_conflict', message: '此頁面已在其他地方更新。', details: { current: { version: 9, updatedAt: 3, title: '標題' } } } } } : undefined);
    await act(async () => { result.current.markDirty(); await result.current.saveNow(); });
    expect(result.current.state.status).toBe('conflict');
    expect(result.current.unsavedConflict()).toBe(true);
    let kept = true;
    await act(async () => { kept = await result.current.keepDraft(true); });
    expect(kept).toBe(false);
    expect(result.current.unsavedConflict()).toBe(true);
    expect((await offlineNote(response.page.id))?.local.page.content).toEqual([]);
  });
});

describe('local copies', () => {
  it('keep their revision when only metadata changed, and get a new one when the text changed', async () => {
    const response = pageOf(), first = await cachePage(response);
    const restyled: PageResponse = { page: { ...response.page, icon: '📌', isFavorite: true, coverUrl: 'gradient:3', parentId: crypto.randomUUID(), updatedAt: 99 }, breadcrumbs: [{ id: 'p', title: '上層改名', icon: null, kind: 'page' }] };
    const second = await cachePage(restyled);
    expect(second.localRevision).toBe(first.localRevision);
    expect((await offlineNote(response.page.id))?.base).toEqual(restyled);
    const edited = await cachePage({ ...restyled, page: { ...restyled.page, version: 5, content: [{ id: 'new' }] } });
    expect(edited.localRevision).not.toBe(first.localRevision);
  });

  it('send the current text, not the rejected one, when a refused note is retried', async () => {
    const response = pageOf(), initial = await cachePage(response);
    online(true);
    const session = { user: me, csrfToken: 'synthetic-token' };
    const calls = stubApi((method, path, body) => {
      if (path === '/api/auth/me') return { json: session };
      if (path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [{ page: (({ content: _content, ...rest }) => rest)(response.page), breadcrumbs: [] }], maxUploadBytes: 1 } };
      if (method === 'PUT') {
        const content = (body as { content: { size: string }[] }).content;
        return content[0]?.size === 'too large' ? { status: 400, json: { error: { code: 'bad_request', message: '頁面內容超過 2 MB。' } } } : { json: { page: { ...response.page, version: 5, content }, breadcrumbs: [] } };
      }
      return undefined;
    });
    const big = await saveLocalContent(response.page.id, [{ size: 'too large' }], initial.localRevision);
    await syncNotes({ force: true });
    const refused = await offlineNote(response.page.id);
    expect(refused).toMatchObject({ pending: true, problem: '頁面內容超過 2 MB。' });
    expect(refused?.sending).toBeUndefined();
    await saveLocalContent(response.page.id, [{ size: 'short' }], big.localRevision);
    // What the "重試同步" button does.
    await updateLocal<OfflineNote>(key(me.id, response.page.id), current => current ? { ...current, problem: undefined, conflict: undefined } : current);
    await syncNotes({ force: true });
    const puts = calls.filter(call => call.method === 'PUT').map(call => call.body as { operationId: string; content: unknown });
    expect(puts.at(-1)?.content).toEqual([{ size: 'short' }]);
    expect(new Set(puts.map(put => put.operationId)).size).toBe(puts.length);
    await waitFor(async () => expect(await offlineNote(response.page.id)).toMatchObject({ pending: false, base: { page: { version: 5 } } }));
  });

  it('drop the text of a note that was deleted online', async () => {
    const response = pageOf();
    await cachePage({ ...response, page: { ...response.page, content: [{ id: 'secret' }] } });
    online(true);
    stubApi((_method, path) => path === '/api/auth/me' ? { json: { user: me, csrfToken: 'synthetic-token' } }
      : path === '/api/offline/manifest' ? { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 1 } } : undefined);
    await syncNotes({ force: true });
    const note = await offlineNote(response.page.id);
    expect(note).toMatchObject({ removed: true, base: { page: { content: [] } }, local: { page: { content: [] } } });
  });
});

describe('two accounts on one browser', () => {
  it('never lets one account’s sign-in or sign-out destroy the other’s unsynced drafts, and removes clean copies', async () => {
    const first = account('first'), second = account('second');
    await rememberUser(first);
    const clean = pageOf(), edited = pageOf();
    await cachePage(clean);
    const cached = await cachePage(edited);
    await saveLocalContent(edited.page.id, [{ id: 'unsynced' }], cached.localRevision);
    await updateLocal(`tree:${first.id}`, () => []);
    await revokeOfflineEntry(); // the first account's session expired

    await rememberUser(second);
    expect(await readLocal(key(first.id, clean.page.id))).toBeUndefined();
    expect(await readLocal(`tree:${first.id}`)).toBeUndefined();
    expect(await readLocal<OfflineNote>(key(first.id, edited.page.id))).toMatchObject({ pending: true });
    expect(await offlineNotes()).toEqual([]);

    const own = pageOf();
    await cachePage(own);
    await forgetOfflineData(); // the second account signs out
    expect(await readLocal(key(second.id, own.page.id))).toBeUndefined();
    expect(await readLocal('user')).toBeUndefined();
    expect(await readLocal<OfflineNote>(key(first.id, edited.page.id))).toMatchObject({ pending: true, local: { page: { content: [{ id: 'unsynced' }] } } });

    await rememberUser(first);
    expect((await offlineNotes()).map(note => note.local.page.id)).toEqual([edited.page.id]);
  });
});

describe('small fixes', () => {
  it('accepts only same-site paths as the post-login destination', () => {
    expect(safeNext('/p/abc?x=1')).toBe('/p/abc?x=1');
    for (const value of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'p/abc']) expect(safeNext(value)).toBe('/');
  });

  it('sends a title typed just before the page is left', () => {
    const onChange = vi.fn();
    const { getByLabelText, unmount } = render(<PageTitle value="舊標題" onChange={onChange} onEnter={() => {}} />);
    fireEvent.change(getByLabelText('頁面標題'), { target: { value: '新標題' } });
    expect(onChange).not.toHaveBeenCalled();
    unmount();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('新標題');
  });
});
