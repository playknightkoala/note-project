// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageKind, PageResponse, UserDto } from '../../src/shared/api.ts';
import { safeNext } from '../../src/client/features/auth/safeNext.ts';
import { PageTitle } from '../../src/client/features/page/PageTitle.tsx';
import { useAutosave } from '../../src/client/features/page/useAutosave.ts';
import { versionToRestoreOn } from '../../src/client/features/page/restoreBase.ts';
import { adoptServerVersion, cachePage, forgetOfflineData, offlineNote, offlineNotes, rememberUser, resolveLocalNote, revokeOfflineEntry, saveLocalContent, syncNotes } from '../../src/client/offline/notes.ts';
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
  it('keeps the text on this device like a note, without mistaking its own save or unrelated local writes for a remote update', async () => {
    const response = pageOf('row'), initial = await cachePage(response);
    const calls = stubApi(() => undefined);
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [{ id: 'row-body' }], onRemoteUpdate: reload }));
    await act(async () => { result.current.markDirty(); await result.current.saveNow(); });
    // Offline: nothing is sent, the draft is stored and waits for the next sync.
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, local: { page: { kind: 'row', content: [{ id: 'row-body' }] } } });
    expect(result.current.state).toMatchObject({ status: 'local', version: 4 });
    // Any write to the local store (the sync loop does one a minute) notifies every open editor.
    await act(async () => { await updateLocal(`tree:${me.id}`, () => []); });
    await tick();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({ status: 'local', version: 4 });
    act(() => result.current.markDirty());
    await act(async () => { await updateLocal(`tree:${me.id}`, () => []); });
    await tick();
    expect(result.current.state.status).toBe('dirty');
    expect(result.current.version()).toBe(4);
  });

  it('syncs a row’s text through the offline endpoint, never its name, and only after a row made on this device exists on the server', async () => {
    const response = pageOf('row', 1), initial = await cachePage(response);
    await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, localOnly: true }));
    await saveLocalContent(response.page.id, [{ id: 'row-body' }], initial.localRevision);
    online(true);
    const calls = stubApi((method, path, body) => {
      if (path === '/api/auth/me') return { json: { user: me, csrfToken: 'synthetic-token' } };
      if (path === '/api/offline/manifest') return { json: { userId: me.id, tree: [], pages: [], maxUploadBytes: 1, databases: [], annotations: [] } };
      if (method === 'PUT') return { json: { page: { ...response.page, version: 2, content: (body as { content: unknown[] }).content }, breadcrumbs: [] } };
      return undefined;
    });
    await syncNotes({ force: true });
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, localOnly: true });
    // The queued "create row" has been carried out: now the page is an ordinary edit on version 1.
    await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, localOnly: undefined }));
    await syncNotes({ force: true });
    const sent = calls.filter(call => call.method === 'PUT');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: `/api/offline/pages/${response.page.id}`, body: { baseVersion: 1, content: [{ id: 'row-body' }] } });
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: false, base: { page: { version: 2 } } });
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

  it.each(['page', 'row'] as const)('keeps the draft of a %s on the device, also when the page is left right away', async kind => {
    const { response, result, unmount } = await conflicted(kind);
    await act(async () => { await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, pending: true, problem: '此頁面已在其他地方更新。', conflict: { version: 9, updatedAt: 3, title: '標題' } })); });
    await waitFor(() => expect(result.current.state.status).toBe('conflict'));
    act(() => result.current.markDirty());
    expect(result.current.unsavedConflict()).toBe(true);
    unmount();
    await waitFor(async () => expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, problem: '此頁面已在其他地方更新。', local: { page: { content: draft } } }));
  });

  it('reports that edits cannot be stored where this device has no copy of the page, so leaving can be confirmed first', async () => {
    const response = pageOf('row');
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, getContent: () => draft, onRemoteUpdate: vi.fn() }));
    await tick();
    stubApi((method, path) => method === 'PUT' && path.endsWith('/content') ? { status: 409, json: { error: { code: 'version_conflict', message: '此頁面已在其他地方更新。', details: { current: { version: 9, updatedAt: 3, title: '標題' } } } } } : undefined);
    await act(async () => { result.current.markDirty(); await result.current.saveNow(); });
    expect(result.current.state.status).toBe('conflict');
    expect(result.current.unsavedConflict()).toBe(true);
    let kept = true;
    await act(async () => { kept = await result.current.keepDraft(true); });
    expect(kept).toBe(false);
    expect(result.current.unsavedConflict()).toBe(true);
    expect(await offlineNote(response.page.id)).toBeUndefined();
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

describe('restoring a history version', () => {
  it.each(['page', 'row'] as const)('is refused while the editor holds text of a %s that could not be stored on this device', async kind => {
    const response = pageOf(kind), initial = await cachePage(response);
    // A value the device store cannot keep stands for any failed write (no space left, for instance).
    let content: unknown[] = [{ id: 'typed', unstorable: () => undefined }];
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => content, onRemoteUpdate: vi.fn() }));
    act(() => result.current.markDirty());
    // The copy on this device still looks clean; the typed text exists only in the editor.
    await expect(act(() => versionToRestoreOn(result.current, kind, response.page.id))).rejects.toThrow('尚未儲存的修改');
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: false, local: { page: { content: [] } } });
    expect(result.current.hasUnsaved()).toBe(true);

    // Once the text is stored it has to reach the server first.
    content = [{ id: 'typed' }];
    await expect(act(() => versionToRestoreOn(result.current, kind, response.page.id))).rejects.toThrow('尚未同步到伺服器');
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, local: { page: { content: [{ id: 'typed' }] } } });
  });

  it('is made on the version this device last received when nothing is waiting', async () => {
    const response = pageOf('page', 7), initial = await cachePage(response);
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 7, initialLocalRevision: initial.localRevision, getContent: () => [], onRemoteUpdate: vi.fn() }));
    await expect(act(() => versionToRestoreOn(result.current, 'page', response.page.id))).resolves.toBe(7);
  });
});

describe('after a history version was restored', () => {
  const restored = (response: PageResponse): PageResponse => ({ ...response, page: { ...response.page, version: response.page.version + 1, content: [{ id: 'restored' }] } });
  const serve = (response: PageResponse) => stubApi((method, path) => method === 'GET' && path === `/api/pages/${response.page.id}` ? { json: restored(response) } : undefined);

  it('takes the restored version as the copy on this device, and an idle editor loads it', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    serve(response);
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [], onRemoteUpdate: reload }));
    await tick();
    await act(async () => { expect(await adoptServerVersion(response.page.id)).toBe('adopted'); });
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: false, base: { page: { version: 5 } }, local: { page: { content: [{ id: 'restored' }] } } });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(result.current.state.status).not.toBe('conflict');
    // Asked again (a sync brought the version in meanwhile): nothing is replaced a second time.
    const revision = (await offlineNote(response.page.id))!.revision;
    expect(await adoptServerVersion(response.page.id)).toBe('adopted');
    expect((await offlineNote(response.page.id))!.revision).toBe(revision);
  });

  it('reports a conflict instead of loading it over text typed while the restore was under way', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    serve(response);
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [{ id: 'typed' }], onRemoteUpdate: reload }));
    await tick();
    // Typed after the last look at the editor, and not stored yet.
    act(() => result.current.markDirty());
    await act(async () => { expect(await adoptServerVersion(response.page.id)).toBe('adopted'); });
    await waitFor(() => expect(result.current.state.status).toBe('conflict'));
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.hasUnsaved()).toBe(true);
  });

  it('never puts an older version over a newer one that reached this device meanwhile', async () => {
    const response = pageOf('page', 6);
    await cachePage(response);
    // The answer to the request made right after the restore arrives late: a sync has brought in version 6 since.
    stubApi((method, path) => method === 'GET' && path === `/api/pages/${response.page.id}` ? { json: { ...response, page: { ...response.page, version: 5, content: [{ id: 'older' }] } } } : undefined);
    const before = await offlineNote(response.page.id);
    expect(await adoptServerVersion(response.page.id)).toBe('adopted');
    expect(await offlineNote(response.page.id)).toMatchObject({ revision: before!.revision, base: { page: { version: 6 } }, local: { page: { version: 6, content: [] } } });
  });

  it('leaves a draft another tab stored on this device alone', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    await saveLocalContent(response.page.id, [{ id: 'other-tab' }], initial.localRevision);
    serve(response);
    expect(await adoptServerVersion(response.page.id)).toBe('kept');
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, base: { page: { version: 4 } }, local: { page: { content: [{ id: 'other-tab' }] } } });
  });

  it('says so when this device keeps no copy of the page', async () => {
    const calls = serve(pageOf('page'));
    expect(await adoptServerVersion(crypto.randomUUID())).toBe('absent');
    expect(calls).toEqual([]);
  });
});

describe('settling a conflict', () => {
  const conflict = { problem: '此頁面已在其他地方更新。', conflict: { version: 9, updatedAt: 3, title: '標題' } };
  const serve = (response: PageResponse, version = 9) => stubApi((method, path) => method === 'GET' && path === `/api/pages/${response.page.id}` ? { json: { ...response, page: { ...response.page, version, content: [{ id: 'theirs' }] } } } : undefined);

  it('is refused from a tab that shows an earlier draft than the one on this device', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    // Another tab has written the draft since this one was opened.
    const newer = await saveLocalContent(response.page.id, [{ id: 'newer' }], initial.localRevision);
    const calls = serve(response);
    await expect(resolveLocalNote(response.page.id, 'overwrite', [{ id: 'older' }], initial.localRevision)).rejects.toMatchObject({ status: 409 });
    await expect(resolveLocalNote(response.page.id, 'reload', undefined, initial.localRevision)).rejects.toMatchObject({ status: 409 });
    // Neither replaced nor thrown away, and the server was not even asked.
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, revision: newer.localRevision, local: { page: { content: [{ id: 'newer' }] } } });
    expect(calls).toEqual([]);
    // The tab that shows the draft as it is may settle it.
    await resolveLocalNote(response.page.id, 'overwrite', [{ id: 'newer' }, { id: 'more' }], newer.localRevision);
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, sending: { input: { overwrite: true, baseVersion: 9, content: [{ id: 'newer' }, { id: 'more' }] } } });
  });

  it('leaves the screen of a tab whose conflict another tab has settled, instead of waiting to be answered again', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => [{ id: 'older' }], onRemoteUpdate: reload }));
    await act(async () => { await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, pending: true, ...conflict })); });
    await waitFor(() => expect(result.current.state.status).toBe('conflict'));
    // The other tab chose "overwrite": a new draft, written by somebody else, and no conflict any more.
    await act(async () => { await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, problem: undefined, conflict: undefined, revision: crypto.randomUUID(), writer: 'another-tab', local: { ...current!.local, page: { ...current!.local.page, content: [{ id: 'chosen-there' }] } } })); });
    await waitFor(() => expect(result.current.state.status).toBe('clean'));
    expect(reload).toHaveBeenCalled();
    expect(await offlineNote(response.page.id)).toMatchObject({ local: { page: { content: [{ id: 'chosen-there' }] } } });
  });

  it('keeps what is typed while an overwrite waits for the server', async () => {
    const response = pageOf('page'), initial = await cachePage(response);
    let content: unknown[] = [{ id: 'at-the-click' }];
    const reload = vi.fn();
    const { result } = renderHook(() => useAutosave({ pageId: response.page.id, initialVersion: 4, initialLocalRevision: initial.localRevision, getContent: () => content, onRemoteUpdate: reload }));
    await act(async () => { await updateLocal<OfflineNote>(key(me.id, response.page.id), current => ({ ...current!, pending: true, ...conflict })); });
    await waitFor(() => expect(result.current.state.status).toBe('conflict'));
    // The server takes its time to say what is there now.
    let answer = () => {};
    const asked = new Promise<void>(resolve => { answer = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { await asked; return new Response(JSON.stringify({ ...response, page: { ...response.page, version: 9, content: [{ id: 'theirs' }] } })); }));
    await act(async () => {
      const settled = result.current.resolveConflict('overwrite');
      await new Promise(resolve => setTimeout(resolve, 20));
      content = [{ id: 'at-the-click' }, { id: 'typed-while-waiting' }];
      result.current.markDirty();
      answer();
      await settled;
    });
    // The overwrite carries what was there at the click; what was typed since is still in the editor and is saved.
    await waitFor(async () => expect((await offlineNote(response.page.id))?.local.page.content).toEqual([{ id: 'at-the-click' }, { id: 'typed-while-waiting' }]));
    expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, sending: { input: { overwrite: true, content: [{ id: 'at-the-click' }] } } });
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.state.status).not.toBe('conflict');
  });
});
