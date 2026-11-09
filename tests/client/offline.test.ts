// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PageResponse, UserDto } from '../../src/shared/api.ts';
import type { SyncNoteInput } from '../../src/shared/offline.ts';
import { cachePage, cachedUser, createLocalNote, forgetOfflineData, loadNote, loadTree, offlineNote, rememberUser, resolveLocalNote, revokeOfflineEntry, saveLocalContent, saveLocalTitle, syncNotes } from '../../src/client/offline/notes.ts';
import type { OfflineNote } from '../../src/client/offline/notes.ts';
import { clearLocal, readLocal, updateLocal } from '../../src/client/offline/storage.ts';

const account: UserDto = { id: crypto.randomUUID(), email: 'synthetic@example.test', username: null, displayName: '合成使用者', role: 'user', createdAt: 0 };
const response: PageResponse = { page: { id: crypto.randomUUID(), parentId: null, kind: 'page', databaseId: null, title: '原標題', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [], version: 7, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 }, breadcrumbs: [] };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function connectivity(online: boolean) { Object.defineProperty(navigator, 'onLine', { configurable: true, value: online }); }
function network(write: (input: SyncNoteInput) => Promise<Response> = async input => reply(200, { ...response, page: { ...response.page, title: input.title, content: input.content, version: (input.baseVersion ?? 0) + 1 } })) {
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/auth/me') return reply(200, { user: account, csrfToken: crypto.randomUUID() });
    if (path.startsWith('/api/offline/')) return write(JSON.parse(options!.body as string) as SyncNoteInput);
    return reply(200, response);
  });
}
beforeEach(async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  connectivity(false);
  await syncNotes();
  await clearLocal(); await rememberUser(account);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
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
  connectivity(true); await syncNotes();
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
