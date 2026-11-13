import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { PageResponse } from '../../src/shared/api.ts';
import { movedSince } from '../../src/shared/offline.ts';
import type { DatabaseSnapshotDto, OfflineManifest, SyncNoteResult } from '../../src/shared/offline.ts';

const password = () => `synthetic ${crypto.randomUUID()}`;
const paragraph = (...content: unknown[]) => ({ id: crypto.randomUUID(), type: 'paragraph', props: {}, content, children: [] });
const text = (value: string) => ({ type: 'text', text: value, styles: {} });
const mention = (pageId: string, title: string) => ({ type: 'pageLink', props: { pageId, title } });

describe('a shared page between its owner and a member', () => {
  let t: TestApp;
  let owner: TestClient, member: TestClient, memberId: string;
  beforeEach(async () => {
    t = createTestApp();
    owner = t.client(); member = t.client();
    await owner.register({ email: 'owner@example.test', displayName: '擁有者', password: password() });
    const { code } = (await (await owner.request('POST', '/api/admin/invites', { json: { expiresInHours: 1 } })).json()) as { code: string };
    memberId = ((await (await member.register({ email: 'member@example.test', displayName: '成員', password: password(), inviteCode: code })).json()) as { user: { id: string } }).user.id;
  });
  afterEach(() => t.close());

  const create = async (input: Record<string, unknown>) => ((await (await owner.request('POST', '/api/pages', { json: input })).json()) as PageResponse).page;
  const read = async (client: TestClient, id: string) => (await (await client.request('GET', `/api/pages/${id}`)).json()) as PageResponse;
  const share = (id: string, role: string) => owner.request('PUT', `/api/pages/${id}/share/members`, { json: { email: 'member@example.test', role } });
  /** As the current interface sends it; `repeatAware: false` is an interface from before `applied` existed. */
  const sync = (client: TestClient, id: string, input: { operationId: string; baseVersion: number; content: unknown[]; title?: string; baseTitle?: string; repeatAware?: boolean }) =>
    client.request('PUT', `/api/offline/pages/${id}`, { json: { baseTitle: '筆記', title: '筆記', parentId: null, overwrite: false, repeatAware: true, ...input }, headers: { 'if-match': `"${input.baseVersion}"` } });

  it('tells a repeated operation apart from the page as it is now, so a device never builds on somebody else\'s save', async () => {
    const page = await create({ title: '筆記' });
    await share(page.id, 'editor');
    const operationId = crypto.randomUUID();
    const first = (await (await sync(owner, page.id, { operationId, baseVersion: 1, content: [paragraph(text('甲的第一版'))] })).json()) as SyncNoteResult;
    expect(first).toMatchObject({ page: { version: 2 }, applied: { version: 2, title: '筆記' } });
    expect(movedSince(first)).toBe(false);
    // The answer was lost; meanwhile the member saved.
    expect((await sync(member, page.id, { operationId: crypto.randomUUID(), baseVersion: 2, content: [paragraph(text('乙的修改'))] })).status).toBe(200);
    const repeated = (await (await sync(owner, page.id, { operationId, baseVersion: 1, content: [paragraph(text('甲的第一版'))] })).json()) as SyncNoteResult;
    expect(repeated).toMatchObject({ page: { version: 3 }, applied: { version: 2, title: '筆記' } });
    expect(JSON.stringify(repeated.page.content)).toContain('乙的修改');
    expect(movedSince(repeated)).toBe(true);
    // An interface that does not read `applied` would take that answer as its new baseline and save over the
    // member's text. It is refused the way it already understands, and the member's text stays.
    const old = await sync(owner, page.id, { operationId, baseVersion: 1, content: [paragraph(text('甲的第一版'))], repeatAware: false });
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: { code: 'version_conflict', details: { current: { version: 3 } } } });
    // While nothing has happened since its operation, the same interface is answered as before.
    const quiet = await create({ title: '筆記' });
    const quietOperation = crypto.randomUUID();
    const input = { operationId: quietOperation, baseVersion: 1, content: [paragraph(text('內文'))], repeatAware: false };
    expect((await sync(owner, quiet.id, input)).status).toBe(200);
    expect((await sync(owner, quiet.id, input)).status).toBe(200);
    // A rename does not change the content version, but it is somebody else's change all the same.
    const renamed = await create({ title: '筆記' });
    const renameOperation = crypto.randomUUID();
    await sync(owner, renamed.id, { operationId: renameOperation, baseVersion: 1, content: [paragraph(text('內文'))] });
    await owner.request('PATCH', `/api/pages/${renamed.id}`, { json: { title: '別處改的名稱' } });
    const again = (await (await sync(owner, renamed.id, { operationId: renameOperation, baseVersion: 1, content: [paragraph(text('內文'))] })).json()) as SyncNoteResult;
    expect(again).toMatchObject({ page: { version: 2, title: '別處改的名稱' }, applied: { version: 2, title: '筆記' } });
    expect(movedSince(again)).toBe(true);
    expect((await sync(owner, renamed.id, { operationId: renameOperation, baseVersion: 1, content: [paragraph(text('內文'))], repeatAware: false })).status).toBe(409);
  });

  it('makes a change of role part of what tells a device to download a shared database again', async () => {
    const database = await create({ title: '資料庫', kind: 'database' });
    await share(database.id, 'editor');
    const stampOf = async (client: TestClient) => ((await (await client.request('GET', '/api/offline/manifest')).json()) as OfflineManifest).databases.find(item => item.id === database.id)?.stamp;
    const snapshot = async (client: TestClient) => (await (await client.request('GET', `/api/offline/databases/${database.id}`)).json()) as DatabaseSnapshotDto;
    const asEditor = await stampOf(member);
    expect(asEditor).toMatch(/\.editor$/);
    expect((await snapshot(member)).stamp).toBe(asEditor);
    await owner.request('PATCH', `/api/pages/${database.id}/share/members/${memberId}`, { json: { role: 'viewer' } });
    const asViewer = await stampOf(member);
    expect(asViewer).toMatch(/\.viewer$/);
    expect(asViewer).not.toBe(asEditor);
    expect(await snapshot(member)).toMatchObject({ stamp: asViewer, page: { access: { role: 'viewer' } } });
    // The owner's own stamp says nothing about roles and matches the snapshot as before.
    const own = await stampOf(owner);
    expect(own).not.toMatch(/viewer|editor/);
    expect((await snapshot(owner)).stamp).toBe(own);
  });

  it('keeps the titles of pages that are not shared out of what a member reads, and puts them back when the member saves', async () => {
    const shared = await create({ title: '共用頁' });
    const child = await create({ title: '共用的子頁', parentId: shared.id });
    const secret = await create({ title: '未分享的機密標題' });
    await owner.request('PUT', `/api/pages/${shared.id}/share`, { json: { scope: 'subpages' } });
    await share(shared.id, 'editor');
    const content = [paragraph(text('見 '), mention(secret.id, '未分享的機密標題'), text(' 與 '), mention(child.id, '共用的子頁'))];
    expect((await owner.request('PUT', `/api/pages/${shared.id}/content`, { json: { content }, headers: { 'if-match': '"1"' } })).status).toBe(200);

    const seen = await read(member, shared.id);
    expect(JSON.stringify(seen.page.content)).not.toContain('未分享的機密標題');
    expect(JSON.stringify(seen.page.content)).toContain('共用的子頁');
    // The mention itself stays where it is, so the text a member saves back is still the owner's text.
    expect(JSON.stringify(seen.page.content)).toContain(secret.id);
    const batch = (await (await member.request('GET', `/api/offline/pages?ids=${shared.id}`)).json()) as { pages: PageResponse[] };
    expect(batch.pages[0]).toEqual(seen);

    const edited = [...seen.page.content, paragraph(text('成員加的一段'))];
    expect((await member.request('PUT', `/api/pages/${shared.id}/content`, { json: { content: edited }, headers: { 'if-match': `"${seen.page.version}"` } })).status).toBe(200);
    const kept = JSON.stringify((await read(owner, shared.id)).page.content);
    expect(kept).toContain('未分享的機密標題');
    expect(kept).toContain('成員加的一段');
    // What the member reads afterwards is exactly what they sent: nothing makes their editor reload.
    expect((await read(member, shared.id)).page.content).toEqual(edited);
    // The title is the snapshot taken when the mention was written. It survives the member saving the text again
    // after the mentioned page was renamed, and after it was deleted for good.
    const resave = async () => {
      const current = await read(member, shared.id);
      expect((await member.request('PUT', `/api/pages/${shared.id}/content`, { json: { content: current.page.content }, headers: { 'if-match': `"${current.page.version}"` } })).status).toBe(200);
      return JSON.stringify((await read(owner, shared.id)).page.content);
    };
    await owner.request('PATCH', `/api/pages/${secret.id}`, { json: { title: '後來改的名字' } });
    const afterRename = await resave();
    expect(afterRename).toContain('未分享的機密標題');
    expect(afterRename).not.toContain('後來改的名字');
    await owner.request('DELETE', `/api/pages/${secret.id}`);
    await owner.request('DELETE', `/api/trash/${secret.id}`);
    expect(await resave()).toContain('未分享的機密標題');
    // Two mentions of one page may carry different snapshots (written before and after it was renamed). Each keeps
    // its own when the member saves, also after blocks were removed, reordered, or a mention was moved elsewhere.
    const other = await create({ title: '另一個未分享頁' });
    const [one, two, three] = [paragraph(mention(other.id, '改名前'), text('、'), mention(other.id, '改名後')), paragraph(mention(other.id, '第三個快照')), paragraph(text('沒有提及'))];
    const snapshots = async () => {
      const titles: string[] = [];
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') {
          const node = value as { type?: string; props?: { pageId?: string; title?: string } };
          if (node.type === 'pageLink' && node.props?.pageId === other.id) titles.push(node.props.title ?? '');
          else Object.values(value).forEach(collect);
        }
      };
      collect((await read(owner, shared.id)).page.content);
      return titles;
    };
    const put = async (client: TestClient, content: unknown[]) => {
      const version = (await read(client, shared.id)).page.version;
      expect((await client.request('PUT', `/api/pages/${shared.id}/content`, { json: { content }, headers: { 'if-match': `"${version}"` } })).status).toBe(200);
    };
    await put(owner, [one, two, three]);
    const blanked = (await read(member, shared.id)).page.content as { id: string }[];
    expect(JSON.stringify(blanked)).not.toMatch(/改名前|改名後|第三個快照/);
    await put(member, blanked);
    expect(await snapshots()).toEqual(['改名前', '改名後', '第三個快照']);
    await put(member, [blanked[1]!, blanked[2]!, blanked[0]!]);
    expect(await snapshots()).toEqual(['第三個快照', '改名前', '改名後']);
    await put(member, [blanked[2]!, blanked[1]!]);
    expect(await snapshots()).toEqual(['第三個快照']);
    // Moved into a block that did not have it: the snapshot nobody else claims goes along.
    await put(owner, [one, two, three]);
    const again = (await read(member, shared.id)).page.content as { id: string; content: unknown[] }[];
    await put(member, [again[0]!, { ...again[2]!, content: again[1]!.content }]);
    expect(await snapshots()).toEqual(['改名前', '改名後', '第三個快照']);
    // A title the member wrote on a mention of somebody else's page is left alone.
    const foreign = crypto.randomUUID();
    const withForeign = [paragraph(mention(foreign, ''), mention(secret.id, '成員自己寫的'))];
    const version = (await read(member, shared.id)).page.version;
    expect((await member.request('PUT', `/api/pages/${shared.id}/content`, { json: { content: withForeign }, headers: { 'if-match': `"${version}"` } })).status).toBe(200);
    expect((await read(owner, shared.id)).page.content).toEqual(withForeign);
  });
});
