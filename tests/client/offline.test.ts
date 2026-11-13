// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageResponse, UserDto } from '../../src/shared/api.ts';
import { summarizePage } from '../../src/shared/offline.ts';
import type { OfflineManifest, SyncNoteInput } from '../../src/shared/offline.ts';
import { cachePage, cachedUser, createLocalNote, forgetOfflineData, loadNote, loadTree, offlineNote, rememberUser, resolveLocalNote, revokeOfflineEntry, saveLocalContent, saveLocalTitle, syncNotes, syncStatus } from '../../src/client/offline/notes.ts';
import type { OfflineNote } from '../../src/client/offline/notes.ts';
import { readLocal, updateLocal } from '../../src/client/offline/storage.ts';

const account: UserDto = { id: crypto.randomUUID(), email: 'synthetic@example.test', username: null, displayName: '合成使用者', role: 'user', createdAt: 0 };
const response: PageResponse = { page: { id: crypto.randomUUID(), parentId: null, kind: 'page', databaseId: null, title: '原標題', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 7, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 }, breadcrumbs: [] };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function connectivity(online: boolean) { Object.defineProperty(navigator, 'onLine', { configurable: true, value: online }); }
function network(write: (input: SyncNoteInput) => Promise<Response> = async input => reply(200, { ...response, page: { ...response.page, title: input.title, content: input.content, version: (input.baseVersion ?? 0) + 1 } })) {
  const pages = new Map([[response.page.id, response]]);
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/auth/me') return reply(200, { user: account, csrfToken: crypto.randomUUID() });
    if (path === '/api/offline/manifest') return reply(200, { userId: account.id, tree: [], pages: [...pages.values()].map(summarizePage), maxUploadBytes: 90 * 1024 * 1024 });
    if (path.startsWith('/api/offline/')) {
      const result = await write(JSON.parse(options!.body as string) as SyncNoteInput);
      if (result.ok) { const page = await result.clone().json() as PageResponse; pages.set(page.page.id, page); }
      return result;
    }
    if (path.startsWith('/api/pages/')) return reply(200, pages.get(path.slice('/api/pages/'.length)) ?? response);
    return reply(200, response);
  });
}
beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  connectivity(false);
  await syncNotes();
  await forgetOfflineData(); await rememberUser(account);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
});

function pullNetwork(pages: PageResponse[]) {
  const manifest: OfflineManifest = { userId: account.id, tree: [], pages: pages.map(summarizePage), maxUploadBytes: 90 * 1024 * 1024, databases: [], annotations: [] };
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/auth/me') return reply(200, { user: account, csrfToken: crypto.randomUUID() });
    if (path === '/api/offline/manifest') return reply(200, manifest);
    const page = pages.find(item => path === `/api/pages/${item.page.id}`);
    if (page) return reply(200, page);
    return reply(404, { error: { code: 'not_found', message: '已刪除' } });
  });
  vi.stubGlobal('fetch', fetcher); connectivity(true);
  return { manifest, fetcher };
}

it('automatically downloads new and changed notes, skips unchanged content, and reports completion only after storage', async () => {
  await cachePage(response);
  const changed = { ...response, page: { ...response.page, title: '另一裝置的新標題' } };
  const added = { ...response, page: { ...response.page, id: crypto.randomUUID(), content: [{ new: true }] } };
  const { fetcher } = pullNetwork([changed, added]);
  await syncNotes({ force: true });
  expect((await offlineNote(response.page.id))?.local.page.title).toBe(changed.page.title);
  expect((await offlineNote(added.page.id))?.local.page.content).toEqual(added.page.content);
  expect(syncStatus).toMatchObject({ phase: 'complete', completedAt: expect.any(Number) });
  expect(await readLocal(`synced:${account.id}`)).toBe(syncStatus.completedAt);
  const downloads = fetcher.mock.calls.filter(([path]) => path.startsWith('/api/pages/')).length;
  await syncNotes({ force: true });
  expect(fetcher.mock.calls.filter(([path]) => path.startsWith('/api/pages/'))).toHaveLength(downloads);
});

it('never downloads over a conflicted draft and marks remotely deleted clean notes unavailable offline', async () => {
  const initial = await cachePage(response);
  await saveLocalContent(response.page.id, [{ draft: true }], initial.localRevision);
  const removed = { ...response, page: { ...response.page, id: crypto.randomUUID() } };
  await cachePage(removed);
  const { fetcher } = pullNetwork([{ ...response, page: { ...response.page, version: 8 } }]);
  const baseFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async path => path.startsWith('/api/offline/pages/')
    ? reply(409, { error: { code: 'version_conflict', message: '版本衝突', details: { current: { version: 8, title: '', updatedAt: 2 } } } }) : baseFetch(path));
  await syncNotes({ force: true });
  expect(syncStatus.phase).toBe('pending');
  expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, local: { page: { content: [{ draft: true }] } } });
  expect(fetcher.mock.calls.some(([path]) => path === `/api/pages/${response.page.id}`)).toBe(false);
  expect((await offlineNote(removed.page.id))?.removed).toBe(true);
  connectivity(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await expect(loadNote(removed.page.id)).rejects.toMatchObject({ status: 404 });
  const removedNote = await offlineNote(removed.page.id);
  await saveLocalContent(removed.page.id, [{ rescued: true }], removedNote?.revision);
  expect((await loadNote(removed.page.id)).page.content).toEqual([{ rescued: true }]);
});

it('backs off failed downloads, retains the last successful timestamp, and allows an explicit retry', async () => {
  const { fetcher } = pullNetwork([response]);
  await syncNotes({ force: true });
  const completedAt = syncStatus.completedAt;
  fetcher.mockImplementation(async () => { throw new TypeError('network unavailable'); });
  await syncNotes({ force: true });
  expect(syncStatus).toMatchObject({ phase: 'error', completedAt });
  const calls = fetcher.mock.calls.length;
  await syncNotes();
  expect(fetcher.mock.calls).toHaveLength(calls);
  await syncNotes({ force: true });
  expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
});

it('does not cache a response under a different account after switching while a download is pending', async () => {
  let release!: (response: Response) => void;
  const { fetcher } = pullNetwork([response]);
  const baseFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async path => path === `/api/pages/${response.page.id}` ? new Promise<Response>(resolve => { release = resolve; }) : baseFetch(path));
  const running = syncNotes({ force: true });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const other = { ...account, id: crypto.randomUUID() };
  await rememberUser(other);
  release(reply(200, response)); await running;
  expect(await readLocal(`page:${other.id}:${response.page.id}`)).toBeUndefined();
  expect(syncStatus.phase).toBe('idle');
});

it('rejects a manifest belonging to another login even if cookies change after the session check', async () => {
  const { manifest, fetcher } = pullNetwork([response]);
  manifest.userId = crypto.randomUUID();
  await syncNotes({ force: true });
  expect(syncStatus.phase).toBe('error');
  expect(await offlineNote(response.page.id)).toBeUndefined();
  expect(fetcher.mock.calls.some(([path]) => path.startsWith('/api/pages/'))).toBe(false);
});

it('does not announce success when a full download only partially completes', async () => {
  const added = { ...response, page: { ...response.page, id: crypto.randomUUID() } };
  const { fetcher } = pullNetwork([response, added]);
  const baseFetch = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async path => path === `/api/pages/${added.page.id}` ? reply(503, {}) : baseFetch(path));
  await syncNotes({ force: true });
  expect(syncStatus).toMatchObject({ phase: 'error', completedAt: null });
  expect(await offlineNote(response.page.id)).toBeDefined();
  expect(await readLocal(`synced:${account.id}`)).toBeUndefined();
});

it('preserves a competing tab edit made while a conflict resolution fetch is pending', async () => {
  const initial = await cachePage(response);
  await saveLocalContent(response.page.id, [{ originalDraft: true }], initial.localRevision);
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const resolution = resolveLocalNote(response.page.id, 'reload');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await updateLocal<OfflineNote>(`page:${account.id}:${response.page.id}`, current => ({ ...current!, revision: crypto.randomUUID(), local: { ...current!.local, page: { ...current!.local.page, content: [{ competingDraft: true }] } } }));
  release(reply(200, response));
  await expect(resolution).rejects.toMatchObject({ status: 409 });
  expect((await offlineNote(response.page.id))?.local.page.content).toEqual([{ competingDraft: true }]);
});
afterEach(async () => { await syncNotes(); vi.unstubAllGlobals(); });

it('persists offline edits and new notes across a fresh client, and never stores CSRF tokens', async () => {
  const initial = await cachePage(response);
  const content = [{ id: 'draft', type: 'paragraph' }];
  await saveLocalContent(response.page.id, content, initial.localRevision);
  await saveLocalTitle(response.page.id, '手機標題');
  const created = await createLocalNote({ title: '新筆記' });
  const reopened = await loadNote(response.page.id);
  expect(reopened.page).toMatchObject({ title: '手機標題', content });
  expect((await loadTree()).map(n => n.id)).toContain(created.page.id);
  // Read through a newly imported module: the draft must come from IndexedDB, not module memory.
  vi.resetModules();
  const fresh = await import('../../src/client/offline/notes.ts');
  await fresh.cachedUser();
  expect((await fresh.loadNote(response.page.id)).page).toEqual(reopened.page);
  expect(await readLocal('user')).toEqual(account);
  expect(await readLocal('user')).not.toHaveProperty('csrfToken');
});

it('retries an uncertain write with the same operation id, preserving edits made while it was in flight', async () => {
  const initial = await cachePage(response);
  await saveLocalContent(response.page.id, [{ draft: 1 }], initial.localRevision);
  const sent: SyncNoteInput[] = [];
  const fetcher = network(async input => { sent.push(input); if (sent.length === 1) throw new TypeError('response lost'); return reply(200, { ...response, page: { ...response.page, content: input.content, version: 8 } }); });
  vi.stubGlobal('fetch', fetcher); connectivity(true);
  await syncNotes();
  connectivity(false);
  await saveLocalContent(response.page.id, [{ draft: 2 }]);
  connectivity(true); await syncNotes({ force: true });
  expect(sent[0]?.operationId).toBe(sent[1]?.operationId);
  const pending = await offlineNote(response.page.id);
  expect(pending).toMatchObject({ pending: true, base: { page: { version: 8 } }, local: { page: { content: [{ draft: 2 }] } } });
  await syncNotes();
  expect(sent[2]?.baseVersion).toBe(8);
  expect(sent[2]?.operationId).not.toBe(sent[1]?.operationId);
  expect((await offlineNote(response.page.id))?.pending).toBe(false);
});

it('keeps conflicts durable and overwrites only after an explicit choice against a freshly fetched head', async () => {
  const initial = await cachePage(response);
  await saveLocalContent(response.page.id, [{ local: true }], initial.localRevision);
  connectivity(true);
  vi.stubGlobal('fetch', network(async () => reply(409, { error: { code: 'version_conflict', message: '版本衝突', details: { current: { version: 12, title: '遠端', updatedAt: 2 } } } })));
  await syncNotes();
  expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, problem: '版本衝突', local: { page: { content: [{ local: true }] } } });
  const sent: SyncNoteInput[] = [];
  const fetcher = network(async input => { sent.push(input); return reply(200, { ...response, page: { ...response.page, version: 13 } }); });
  vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => path === `/api/pages/${response.page.id}` ? reply(200, { ...response, page: { ...response.page, version: 12, title: '遠端' } }) : fetcher(path, options));
  await resolveLocalNote(response.page.id, 'overwrite'); await syncNotes();
  expect(sent[0]).toMatchObject({ baseVersion: 12, overwrite: true, content: [{ local: true }] });
});

it('does not serve stale notes after 404, replay queues under another login, or silently replace another tab draft', async () => {
  const initial = await cachePage(response);
  const key = `page:${account.id}:${response.page.id}`;
  await updateLocal<OfflineNote>(key, current => ({ ...current!, writer: 'another-tab', revision: 'new-revision', pending: true }));
  await expect(saveLocalContent(response.page.id, [], initial.localRevision)).rejects.toMatchObject({ status: 409 });
  vi.stubGlobal('fetch', vi.fn(async () => reply(404, { error: { code: 'not_found', message: '不存在' } })));
  await expect(loadNote(response.page.id)).rejects.toMatchObject({ status: 404 });
  connectivity(true);
  const fetcher = vi.fn(async () => reply(200, { user: { ...account, id: crypto.randomUUID() }, csrfToken: crypto.randomUUID() }));
  vi.stubGlobal('fetch', fetcher); await syncNotes();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await offlineNote(response.page.id))?.pending).toBe(true);
  await revokeOfflineEntry(); expect(await cachedUser()).toBeNull();
  await rememberUser(account); expect((await offlineNote(response.page.id))?.pending).toBe(true);
  await forgetOfflineData(); expect(await cachedUser()).toBeNull();
});

it('syncs a newly created parent before its child', async () => {
  const parent = await createLocalNote({ title: '上層' });
  const child = await createLocalNote({ parentId: parent.page.id, title: '子頁' });
  const sent: SyncNoteInput[] = [];
  vi.stubGlobal('fetch', network(async input => { sent.push(input); const source = input.title === '上層' ? parent : child; return reply(200, { ...source, page: { ...source.page, version: 2 } }); }));
  connectivity(true); await syncNotes();
  expect(sent.map(s => s.title)).toEqual(['上層', '子頁']);
});

it('treats what was written since a lost answer as a conflict when somebody else has saved meanwhile, never as a draft on their text', async () => {
  const initial = await cachePage(response);
  const first = await saveLocalContent(response.page.id, [{ mine: 1 }], initial.localRevision);
  const sent: SyncNoteInput[] = [];
  // The first attempt reaches the server but its answer is lost. The repeat is answered with the page as it is by
  // then: somebody else's version 9, while this operation had produced version 8.
  const fetcher = network(async input => {
    sent.push(input);
    if (sent.length === 1) throw new TypeError('answer lost');
    return reply(200, { ...response, page: { ...response.page, content: [{ theirs: true }], version: 9 }, applied: { version: 8, title: response.page.title } });
  });
  vi.stubGlobal('fetch', fetcher); connectivity(true);
  await syncNotes({ force: true });
  expect(await offlineNote(response.page.id)).toMatchObject({ pending: true, sending: { input: { baseVersion: 7 } } });
  await saveLocalContent(response.page.id, [{ mine: 2 }], first.localRevision);
  await syncNotes({ force: true });
  await syncNotes({ force: true });
  // Sent twice under one operation id, and never again on top of the other person's version.
  expect(sent.map(input => input.baseVersion)).toEqual([7, 7]);
  expect(new Set(sent.map(input => input.operationId)).size).toBe(1);
  // The interface says that it reads `applied`; without that the server would have refused the repeat instead.
  expect(sent.every(input => input.repeatAware === true)).toBe(true);
  const note = await offlineNote(response.page.id);
  expect(note).toMatchObject({ pending: true, problem: '此頁面已在其他地方更新。', conflict: { version: 9 }, base: { page: { version: 7 } }, local: { page: { content: [{ mine: 2 }] } } });
  expect(note?.sending).toBeUndefined();
  expect(syncStatus.phase).toBe('pending');
});

it('replaces the copy kept here, and tells an open editor to load it, when a repeat shows a newer page and nothing was written since', async () => {
  const initial = await cachePage(response);
  const saved = await saveLocalContent(response.page.id, [{ mine: 1 }], initial.localRevision);
  let attempts = 0;
  const fetcher = network(async () => {
    if (++attempts === 1) throw new TypeError('answer lost');
    return reply(200, { ...response, page: { ...response.page, content: [{ theirs: true }], version: 9 }, applied: { version: 8, title: response.page.title } });
  });
  vi.stubGlobal('fetch', fetcher); connectivity(true);
  await syncNotes({ force: true });
  await syncNotes({ force: true });
  const note = await offlineNote(response.page.id);
  expect(note).toMatchObject({ pending: false, writer: '', base: { page: { version: 9, content: [{ theirs: true }] } }, local: { page: { content: [{ theirs: true }] } } });
  expect(note?.revision).not.toBe(saved.localRevision);
  expect(note?.problem).toBeUndefined();
  // The answer's own bookkeeping is not part of the page that is kept.
  expect(note?.base).not.toHaveProperty('applied');
  // An answer to the operation itself (nothing happened in between) is a new baseline as before.
  const again = await saveLocalContent(response.page.id, [{ mine: 3 }], note?.revision);
  attempts = 5;
  fetcher.mockImplementation(async (path: string) => path.startsWith('/api/offline/pages/')
    ? reply(200, { ...response, page: { ...response.page, content: [{ mine: 3 }], version: 10 }, applied: { version: 10, title: response.page.title } })
    : path === '/api/auth/me' ? reply(200, { user: account, csrfToken: crypto.randomUUID() }) : reply(200, { userId: account.id, tree: [], pages: [], maxUploadBytes: 1 }));
  await syncNotes({ force: true });
  expect(await offlineNote(response.page.id)).toMatchObject({ pending: false, revision: again.localRevision, base: { page: { version: 10 } } });
});
