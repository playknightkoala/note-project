import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import { syntheticPng } from '../helpers/png.ts';
import type { PageResponse, SessionDto, TreeDto } from '../../src/shared/api.ts';
import type { Annotation } from '../../src/shared/annotations.ts';
import type { DatabaseDto } from '../../src/shared/database.ts';
import { summarizePage } from '../../src/shared/offline.ts';
import type { DatabaseSnapshotDto, OfflineManifest, OfflineOp, OfflineOpResult } from '../../src/shared/offline.ts';
import type { MemberRole, PublicPageDto, PublicShareDto, ShareScope, SharesDto, ShareStateDto } from '../../src/shared/shares.ts';
import { UNREACHABLE_PAGE } from '../../src/shared/shares.ts';
import { resolveAccess, scopePages } from '../../src/server/services/access.ts';

/**
 * Accounts: `admin` only runs the site; `owner` owns everything below; `viewer` and `editor` are added to shares;
 * `stranger` is never added to anything. All synthetic.
 *
 *   A (page) ── B (page) ── C (page)
 *            └─ D (database) ── R (row)
 *   X (page, never shared)
 */
interface Person { client: TestClient; id: string; email: string }
let t: TestApp, admin: Person, owner: Person, viewer: Person, editor: Person, stranger: Person;
let A: string, B: string, C: string, D: string, R: string, X: string;
const uuid = () => crypto.randomUUID();
const json = async <T>(response: Response | Promise<Response>) => await (await response).json() as T;
const status = async (response: Promise<Response>) => (await response).status;
const text = (id: string, value: string, styles: Record<string, unknown> = {}) => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text: value, styles }], children: [] });

async function person(name: string): Promise<Person> {
  const client = t.client(), email = `${uuid()}@example.test`;
  const invite = admin ? (await json<{ code: string }>(admin.client.request('POST', '/api/admin/invites', { json: { expiresInHours: 24 } }))).code : undefined;
  const session = await json<SessionDto>(client.register({ email, displayName: name, password: uuid(), ...(invite ? { inviteCode: invite } : {}) }));
  return { client, id: session.user.id, email };
}
const create = async (who: Person, input: Record<string, unknown>) => (await json<PageResponse>(who.client.request('POST', '/api/pages', { json: input }))).page.id;
const get = (who: Person, id: string) => who.client.request('GET', `/api/pages/${id}`);
const page = async (who: Person, id: string) => await json<PageResponse>(get(who, id));
const save = async (who: Person, id: string, content: unknown[]) => {
  const version = t.deps.db.get<{ version: number }>('SELECT version FROM pages WHERE id = ?', id)!.version;
  return who.client.request('PUT', `/api/pages/${id}/content`, { json: { content }, headers: { 'if-match': `"${version}"` } });
};
const share = async (id: string, scope: ShareScope, members: [Person, MemberRole][] = []) => {
  expect(await status(owner.client.request('PUT', `/api/pages/${id}/share`, { json: { scope } }))).toBe(200);
  for (const [who, role] of members) expect(await status(owner.client.request('PUT', `/api/pages/${id}/share/members`, { json: { email: who.email, role } }))).toBe(200);
};
const link = async (id: string) => (await json<ShareStateDto>(owner.client.request('POST', `/api/pages/${id}/share/link`))).share!.link!.token;
const op = (who: Person, input: OfflineOp, operationId = uuid()) => who.client.request('POST', '/api/offline/ops', { json: { operationId, force: false, op: input } });
const upload = (who: Person, fields: Record<string, string> = {}, name = '合成.png', bytes: Uint8Array = syntheticPng()) => {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: name.endsWith('.png') ? 'image/png' : 'text/plain' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return who.client.request('POST', '/api/files', { body: form });
};

beforeEach(async () => {
  t = createTestApp();
  admin = undefined as unknown as Person;
  admin = await person('站台管理者');
  owner = await person('擁有者'); viewer = await person('唯讀者'); editor = await person('編輯者'); stranger = await person('陌生人');
  A = await create(owner, { title: '甲' });
  B = await create(owner, { title: '乙', parentId: A });
  C = await create(owner, { title: '丙', parentId: B });
  D = await create(owner, { title: '資料庫', parentId: A, kind: 'database' });
  X = await create(owner, { title: '不分享' });
  R = uuid();
  expect(await status(op(owner, { type: 'row.create', databaseId: D, rowId: R, title: '列', values: {} }))).toBe(200);
});
afterEach(() => t.close());

describe('managing a share', () => {
  it('lets only the owner set the scope, the link and the members', async () => {
    expect(await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${A}/share`))).toEqual({ share: null, inherited: [] });
    await share(A, 'subpages', [[viewer, 'viewer']]);
    const token = await link(A);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${A}/share`));
    expect(state.share).toMatchObject({ pageId: A, scope: 'subpages', link: { token }, members: [{ userId: viewer.id, email: viewer.email, displayName: '唯讀者', role: 'viewer' }] });
    // A page below sees that it is reached from above; one outside the scope does not.
    expect((await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${C}/share`))).inherited).toEqual([{ pageId: A, title: '甲', scope: 'subpages', link: true, members: 1, accountRole: null }]);
    expect((await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${D}/share`))).inherited).toEqual([]);
    // Role change, removal.
    expect((await json<ShareStateDto>(owner.client.request('PATCH', `/api/pages/${A}/share/members/${viewer.id}`, { json: { role: 'editor' } }))).share!.members[0]!.role).toBe('editor');
    expect((await json<ShareStateDto>(owner.client.request('DELETE', `/api/pages/${A}/share/members/${viewer.id}`))).share!.members).toEqual([]);
    expect(await status(owner.client.request('DELETE', `/api/pages/${A}/share/members/${viewer.id}`))).toBe(404);
    // Members, strangers and visitors cannot look at or change any of it.
    await share(A, 'subpages', [[editor, 'editor']]);
    for (const who of [editor, stranger]) {
      expect(await status(who.client.request('GET', `/api/pages/${A}/share`))).toBe(404);
      expect(await status(who.client.request('PUT', `/api/pages/${A}/share`, { json: { scope: 'all' } }))).toBe(404);
      expect(await status(who.client.request('POST', `/api/pages/${A}/share/link`))).toBe(404);
      expect(await status(who.client.request('PUT', `/api/pages/${A}/share/members`, { json: { email: stranger.email, role: 'editor' } }))).toBe(404);
      expect(await status(who.client.request('DELETE', `/api/pages/${A}/share`))).toBe(404);
    }
    expect(await status(t.client().request('GET', `/api/pages/${A}/share`))).toBe(401);
    expect(await status(owner.client.request('PUT', `/api/pages/${A}/share`, { json: { scope: 'all' }, csrf: false }))).toBe(403);
    expect((await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${A}/share`))).share).toMatchObject({ scope: 'subpages', link: { token } });
  });

  it('adds members by exact address only and gives nothing away about other accounts', async () => {
    const add = (email: string) => owner.client.request('PUT', `/api/pages/${A}/share/members`, { json: { email, role: 'viewer' } });
    const unknown = await add(`${uuid()}@example.test`);
    expect(unknown.status).toBe(404);
    // A disabled account is answered exactly like an address nobody registered.
    expect(await status(admin.client.request('PATCH', `/api/admin/users/${stranger.id}`, { json: { disabled: true } }))).toBe(200);
    const disabled = await add(stranger.email);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual(await unknown.json());
    expect(await status(add(owner.email))).toBe(400);
    expect(await status(add(viewer.email.toUpperCase()))).toBe(200);
    expect(await status(owner.client.request('PUT', `/api/pages/${R}/share`, { json: { scope: 'page' } }))).toBe(400);
    for (let attempt = 0; attempt < 30; attempt++) await add(`${uuid()}@example.test`);
    expect(await status(add(editor.email))).toBe(429);
  });

  it('lists what I share and what is shared with me, and lets a member leave', async () => {
    await share(A, 'all', [[viewer, 'viewer']]);
    await share(B, 'page', [[viewer, 'editor']]);
    await share(X, 'page');
    const mine = await json<SharesDto>(owner.client.request('GET', '/api/shares'));
    // A share nobody can reach (no link, no member) is not listed.
    expect(mine.outgoing.map(item => item.pageId).sort()).toEqual([A, B].sort());
    expect(mine.incoming).toEqual([]);
    expect((await json<TreeDto>(owner.client.request('GET', '/api/pages/tree'))).pages.filter(node => node.shared).map(node => node.id).sort()).toEqual([A, B].sort());
    const theirs = await json<SharesDto>(viewer.client.request('GET', '/api/shares'));
    expect(theirs.outgoing).toEqual([]);
    // B lies inside A's share and is therefore shown there only; rows never appear in a tree.
    expect(theirs.incoming).toMatchObject([{ pageId: A, role: 'viewer', scope: 'all', owner: { id: owner.id, name: '擁有者' } }]);
    expect(theirs.incoming[0]!.tree.map(node => [node.id, node.parentId])).toEqual([[A, null], [B, A], [D, A], [C, B]]);
    expect(await status(stranger.client.request('DELETE', `/api/shares/incoming/${A}`))).toBe(404);
    expect(await status(viewer.client.request('DELETE', `/api/shares/incoming/${A}`))).toBe(204);
    expect((await json<SharesDto>(viewer.client.request('GET', '/api/shares'))).incoming.map(item => item.pageId)).toEqual([B]);
    expect(await status(get(viewer, A))).toBe(404);
    expect(await status(get(viewer, B))).toBe(200);
  });
});

describe('what a member may do', () => {
  it('shows a shared page without anything of the owner\'s own organisation', async () => {
    await owner.client.request('POST', `/api/pages/${B}/favorite`, { json: { favorite: true } });
    await share(B, 'subpages', [[viewer, 'viewer']]);
    const shared = await page(viewer, B);
    expect(shared.page).toMatchObject({ id: B, parentId: null, isFavorite: false, title: '乙' });
    expect(shared.breadcrumbs.map(crumb => crumb.id)).toEqual([B]);
    expect(shared.access).toEqual({ role: 'viewer', rootId: B, owner: { id: owner.id, name: '擁有者' } });
    const child = await page(viewer, C);
    expect(child.page.parentId).toBe(B);
    expect(child.breadcrumbs.map(crumb => crumb.id)).toEqual([B, C]);
    // The owner's own view is unchanged and carries no access entry.
    const own = await page(owner, B);
    expect(own.page).toMatchObject({ parentId: A, isFavorite: true });
    expect(own.breadcrumbs.map(crumb => crumb.id)).toEqual([A, B]);
    expect('access' in own).toBe(false);
    for (const id of [A, D, R, X]) expect(await status(get(viewer, id))).toBe(404);
    for (const id of [A, B, C, D, R, X]) expect(await status(get(stranger, id))).toBe(404);
    expect(await status(t.client().request('GET', `/api/pages/${B}`))).toBe(401);
  });

  it('applies each scope to pages, databases and rows', async () => {
    const reach = async (who: Person) => { const found: string[] = []; for (const [name, id] of Object.entries({ A, B, C, D, R, X })) if (await status(get(who, id)) === 200) found.push(name); return found.join(''); };
    await share(A, 'page', [[viewer, 'viewer']]);
    expect(await reach(viewer)).toBe('A');
    await share(A, 'subpages');
    expect(await reach(viewer)).toBe('ABC');
    await share(A, 'all');
    expect(await reach(viewer)).toBe('ABCDR');
    // A shared database always comes with its rows.
    await owner.client.request('DELETE', `/api/pages/${A}/share`);
    expect(await reach(viewer)).toBe('');
    await share(D, 'page', [[viewer, 'viewer']]);
    expect(await reach(viewer)).toBe('DR');
    expect((await page(viewer, R)).breadcrumbs.map(crumb => crumb.id)).toEqual([D, R]);
  });

  it('gives the highest role where shares overlap and resolves a page like the list of shared pages does', async () => {
    await share(A, 'all', [[viewer, 'viewer']]);
    await share(B, 'subpages', [[viewer, 'editor']]);
    expect((await page(viewer, A)).access).toMatchObject({ role: 'viewer', rootId: A });
    expect((await page(viewer, C)).access).toMatchObject({ role: 'editor', rootId: A });
    expect((await page(viewer, D)).access).toMatchObject({ role: 'viewer', rootId: A });
    // On random trees: a page is reachable exactly when some share's scope lists it.
    for (let round = 0; round < 20; round++) {
      const ids: { id: string; kind: string }[] = [{ id: A, kind: 'page' }];
      for (let n = 0; n < 8; n++) {
        const parent = ids.filter(item => item.kind === 'page')[Math.floor(Math.random() * ids.filter(item => item.kind === 'page').length)]!;
        const kind = Math.random() < 0.3 ? 'database' : 'page';
        ids.push({ id: await create(owner, { parentId: parent.id, kind, title: `${round}-${n}` }), kind });
      }
      const root = ids[Math.floor(Math.random() * ids.length)]!, scope = (['page', 'subpages', 'all'] as const)[round % 3]!;
      t.deps.db.run('DELETE FROM page_shares');
      await share(root.id, scope, [[viewer, 'viewer']]);
      const listed = new Set(scopePages(t.deps.db, owner.id, root.id, scope).map(item => item.id));
      for (const item of [...ids, { id: B }, { id: R }, { id: X }]) {
        let reachable = true;
        try { resolveAccess(t.deps.db, viewer.id, item.id); } catch { reachable = false; }
        expect(reachable, `${scope} ${item.id}`).toBe(listed.has(item.id));
      }
    }
  });

  it('lets an editor change text and title, a viewer nothing, and keeps the rest for the owner', async () => {
    await share(A, 'all', [[viewer, 'viewer'], [editor, 'editor']]);
    expect(await status(save(owner, B, [text('p', '擁有者寫的')]))).toBe(200);
    expect(await status(save(viewer, B, [text('p', '唯讀者想改')]))).toBe(403);
    expect(await status(save(editor, B, [text('p', '編輯者改的')]))).toBe(200);
    expect((await page(owner, B)).page.content).toEqual([text('p', '編輯者改的')]);
    // The owner's text was kept in the history the moment somebody else replaced it.
    const versions = (await json<{ versions: { id: string }[] }>(owner.client.request('GET', `/api/pages/${B}/versions`))).versions;
    // (The first save had already kept the empty page; the newest entry is what the editor replaced.)
    expect(versions).toHaveLength(2);
    expect((await json<{ content: unknown[] }>(owner.client.request('GET', `/api/pages/${B}/versions/${versions[0]!.id}`))).content).toEqual([text('p', '擁有者寫的')]);
    const patch = (who: Person, id: string, body: unknown) => who.client.request('PATCH', `/api/pages/${id}`, { json: body });
    const renamed = await json<PageResponse>(patch(editor, B, { title: '乙（改）' }));
    expect(renamed).toMatchObject({ page: { title: '乙（改）', isFavorite: false }, access: { role: 'editor' } });
    expect(renamed.breadcrumbs.map(crumb => crumb.title)).toEqual(['甲', '乙（改）']);
    expect(await status(patch(viewer, B, { title: '不行' }))).toBe(403);
    expect(await status(patch(editor, B, { icon: '🙂' }))).toBe(403);
    expect(await status(patch(editor, B, { title: '可以', fullWidth: true }))).toBe(403);
    expect(await status(patch(editor, R, { title: '列改名' }))).toBe(403);
    expect(await status(patch(stranger, B, { title: '不行' }))).toBe(404);
    // Everything that organises the owner's notes stays "not found" for members.
    for (const who of [viewer, editor]) {
      expect(await status(who.client.request('POST', '/api/pages', { json: { parentId: B, title: '子頁' } }))).toBe(404);
      expect(await status(who.client.request('POST', `/api/pages/${B}/move`, { json: { parentId: null, index: 0 } }))).toBe(404);
      expect(await status(who.client.request('POST', `/api/pages/${B}/favorite`, { json: { favorite: true } }))).toBe(404);
      expect(await status(who.client.request('POST', `/api/pages/${B}/duplicate`))).toBe(404);
      expect(await status(who.client.request('DELETE', `/api/pages/${B}`))).toBe(404);
      expect(await status(who.client.request('GET', `/api/pages/${B}/versions`))).toBe(404);
      expect(await status(who.client.request('GET', `/api/search?q=${encodeURIComponent('編輯者改的')}`))).toBe(200);
      expect((await json<{ results: unknown[] }>(who.client.request('GET', `/api/search?q=${encodeURIComponent('編輯者改的')}`))).results).toEqual([]);
      expect((await json<TreeDto>(who.client.request('GET', '/api/pages/tree'))).pages).toEqual([]);
      expect(await status(who.client.request('GET', '/api/trash'))).toBe(200);
    }
    expect((await page(owner, B)).page.title).toBe('乙（改）');
  });

  it('keeps the owner\'s versions in the history however often members save', async () => {
    await share(A, 'all', [[editor, 'editor']]);
    expect(await status(save(owner, B, [text('p', '擁有者的原文')]))).toBe(200);
    const overwrite = async (value: string) => {
      const version = t.deps.db.get<{ version: number }>('SELECT version FROM pages WHERE id = ?', B)!.version;
      return editor.client.request('PUT', `/api/pages/${B}/content`, { json: { content: [text('p', value)], overwrite: true }, headers: { 'if-match': `"${version}"` } });
    };
    for (let n = 0; n < 130; n++) { t.clock.now += 11 * 60 * 1000; expect(await status(overwrite(`編輯者第 ${n} 次`))).toBe(200); }
    const versions = (await json<{ versions: { id: string }[] }>(owner.client.request('GET', `/api/pages/${B}/versions`))).versions;
    // A member's saves fill their own allowance; the owner's text is still there to be restored.
    expect(versions.length).toBeLessThanOrEqual(200);
    const stored = t.deps.db.all<{ content: string; written_by: string | null }>('SELECT content, written_by FROM page_versions WHERE page_id = ?', B);
    expect(stored.filter(item => item.written_by === editor.id).length).toBe(100);
    expect(stored.some(item => item.written_by === null && item.content.includes('擁有者的原文'))).toBe(true);
    // Repeated explicit overwrites by the same member inside the usual interval do not each add a version.
    const count = stored.length;
    for (let n = 0; n < 5; n++) await overwrite(`連續 ${n}`);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?', B)!.n).toBe(count);
  });

  it('lets the owner take a member off the list while the page is in the trash', async () => {
    await share(A, 'all', [[editor, 'editor']]);
    await owner.client.request('DELETE', `/api/pages/${A}`);
    expect(await status(owner.client.request('DELETE', `/api/pages/${A}/share/members/${editor.id}`))).toBe(200);
    await owner.client.request('POST', `/api/trash/${A}/restore`);
    // Restoring does not give the access back.
    expect(await status(get(editor, A))).toBe(404);
    expect(await status(get(owner, A))).toBe(200);
  });

  it('ends with the trash, with the owner\'s account, with removal and with the share itself', async () => {
    await share(A, 'all', [[editor, 'editor']]);
    await owner.client.request('DELETE', `/api/pages/${B}`);
    expect(await status(get(editor, B))).toBe(404);
    expect(await status(get(editor, C))).toBe(404);
    expect(await status(get(owner, B))).toBe(200);
    expect(await status(get(editor, A))).toBe(200);
    await owner.client.request('POST', `/api/trash/${B}/restore`);
    expect(await status(get(editor, C))).toBe(200);
    expect(await status(admin.client.request('PATCH', `/api/admin/users/${owner.id}`, { json: { disabled: true } }))).toBe(200);
    expect(await status(get(editor, A))).toBe(404);
    expect((await json<SharesDto>(editor.client.request('GET', '/api/shares'))).incoming).toEqual([]);
    t.deps.db.run('UPDATE users SET disabled_at = NULL WHERE id = ?', owner.id);
    expect(await status(get(editor, A))).toBe(200);
    t.deps.db.run('DELETE FROM share_members WHERE user_id = ?', editor.id);
    expect(await status(get(editor, A))).toBe(404);
    expect(await status(save(editor, B, [text('p', '已被移除')]))).toBe(404);
  });

  it('opens databases to members: rows for editors, the structure for the owner alone', async () => {
    await share(A, 'all', [[viewer, 'viewer'], [editor, 'editor']]);
    for (const who of [viewer, editor]) {
      expect((await json<DatabaseDto>(who.client.request('GET', `/api/databases/${D}`))).id).toBe(D);
      expect((await json<{ total: number }>(who.client.request('GET', `/api/databases/${D}/rows`))).total).toBe(1);
      expect(await status(who.client.request('GET', `/api/rows/${R}`))).toBe(200);
      const snapshot = await json<DatabaseSnapshotDto>(who.client.request('GET', `/api/offline/databases/${D}`));
      expect(snapshot.page).toMatchObject({ page: { id: D }, access: { rootId: A } });
      expect(snapshot.pages[0]).toEqual(summarizePage(await page(who, R)));
      // The REST writes are the owner's; members only use operations.
      expect(await status(who.client.request('POST', `/api/databases/${D}/rows`, { json: { title: '直接新增', values: {} }, headers: { 'if-match': '"1"' } }))).toBe(404);
      expect(await status(who.client.request('POST', `/api/databases/${D}/properties`, { json: { name: '欄', type: 'text' }, headers: { 'if-match': '"1"' } }))).toBe(404);
      expect(await status(op(who, { type: 'property.add', databaseId: D, propertyId: uuid(), baseVersion: 1, input: { name: '欄', type: 'text', choices: [] } }))).toBe(403);
      expect(await status(op(who, { type: 'view.delete', databaseId: D, viewId: uuid(), baseVersion: 1 }))).toBe(403);
    }
    for (const who of [stranger]) {
      expect(await status(who.client.request('GET', `/api/databases/${D}`))).toBe(404);
      expect(await status(who.client.request('GET', `/api/rows/${R}`))).toBe(404);
      expect(await status(who.client.request('GET', `/api/offline/databases/${D}`))).toBe(404);
      expect(await status(op(who, { type: 'row.update', databaseId: D, rowId: R, title: { base: '列', value: '陌生人' }, values: {} }))).toBe(404);
      expect(await status(op(who, { type: 'property.add', databaseId: D, propertyId: uuid(), baseVersion: 1, input: { name: '欄', type: 'text', choices: [] } }))).toBe(404);
    }
    const rename: OfflineOp = { type: 'row.update', databaseId: D, rowId: R, title: { base: '列', value: '編輯者改名' }, values: {} };
    expect(await status(op(viewer, rename))).toBe(403);
    expect((await json<OfflineOpResult>(op(editor, rename))).row?.title).toBe('編輯者改名');
    const added = uuid();
    expect(await status(op(viewer, { type: 'row.create', databaseId: D, rowId: uuid(), title: '不行', values: {} }))).toBe(403);
    expect((await json<OfflineOpResult>(op(editor, { type: 'row.create', databaseId: D, rowId: added, title: '編輯者新增', values: {} }))).row?.id).toBe(added);
    // The new row is the owner's, and the editor can write its page.
    expect(t.deps.db.get<{ user_id: string }>('SELECT user_id FROM pages WHERE id = ?', added)?.user_id).toBe(owner.id);
    expect(await status(save(editor, added, [text('p', '列內文')]))).toBe(200);
    expect((await json<{ total: number }>(owner.client.request('GET', `/api/databases/${D}/rows`))).total).toBe(2);
  });
});

describe('what the public link gives a signed-in account', () => {
  const setAccounts = (id: string, role: MemberRole | null, who = owner) => who.client.request('PUT', `/api/pages/${id}/share/account-link`, { json: { role } });
  const accounts = async (id: string, role: MemberRole | null) => await json<ShareStateDto>(setAccounts(id, role));
  const state = async (id: string) => (await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${id}/share`))).share;
  const enter = (who: Person, token: string, pageId?: string) => who.client.request('POST', '/api/shares/open', { json: { token, ...(pageId ? { pageId } : {}) } });
  const peek = (token: string, client = t.client()) => client.request('GET', `/api/public/${token}`);
  const incoming = async (who: Person) => (await json<SharesDto>(who.client.request('GET', '/api/shares'))).incoming;
  const manifest = async (who: Person) => await json<OfflineManifest>(who.client.request('GET', '/api/offline/manifest'));
  const visitors = () => t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM share_visitors')?.n;

  it('gives the chosen role to an account that opens the link, within the scope, and nothing for knowing the page', async () => {
    await share(A, 'subpages');
    // The role is a setting of the public link: while the link is off there is nothing to set.
    expect(await status(setAccounts(A, 'viewer'))).toBe(400);
    expect(await state(A)).toMatchObject({ accountRole: null, link: null });
    const token = await link(A);
    for (const who of [stranger, editor]) expect(await status(setAccounts(A, 'editor', who))).toBe(404);
    expect((await accounts(A, 'viewer')).share).toMatchObject({ accountRole: 'viewer', visitors: [], link: { token } });
    // The page's own address gives nothing, and nothing of the share is listed for anybody.
    for (const id of [A, B]) expect(await status(get(stranger, id))).toBe(404);
    expect(await incoming(stranger)).toEqual([]);
    expect((await manifest(stranger)).pages).toEqual([]);
    // Without an account the link works as it always did: the read-only copy, and no way further in.
    expect(await json<PublicShareDto>(peek(token))).toMatchObject({ rootId: A });
    expect(await status(t.client().request('POST', '/api/shares/open', { json: { token } }))).toBe(401);
    // A signed-in account is told the link is meant for it. Being told grants nothing; opening it does, and that is a write.
    expect(await json(peek(token, stranger.client))).toEqual({ account: true });
    expect(await status(stranger.client.request('POST', '/api/shares/open', { json: { token }, csrf: false }))).toBe(403);
    expect(await status(get(stranger, A))).toBe(404);
    expect(visitors()).toBe(0);
    expect(await status(enter(stranger, 'y'.repeat(43)))).toBe(404);
    expect(await json(enter(stranger, token))).toEqual({ pageId: A });
    // Opened at a page below: that page when the share reaches it, otherwise the shared page.
    expect(await json(enter(stranger, token, B))).toEqual({ pageId: B });
    for (const id of [D, X]) expect(await json(enter(stranger, token, id))).toEqual({ pageId: A });
    const first = await page(stranger, B);
    expect(first).toMatchObject({ page: { id: B, isFavorite: false }, access: { role: 'viewer', rootId: A, owner: { id: owner.id } } });
    expect(first.breadcrumbs.map(crumb => crumb.id)).toEqual([A, B]);
    // The scope applies exactly as for members, and reading is all a viewer may do.
    for (const id of [D, R, X]) expect(await status(get(stranger, id))).toBe(404);
    expect(await status(save(stranger, B, [text('p', '不能改')]))).toBe(403);
    expect(await status(op(stranger, { type: 'annotation.create', pageId: B, annotationId: uuid(), messageId: uuid(), quote: '乙', blockIds: ['p'], text: '可以留言', at: 1, floating: true }))).toBe(200);
    // Having opened it, the account finds the shared page in its list and on its devices; the owner sees who came in.
    expect(await incoming(stranger)).toMatchObject([{ pageId: A, role: 'viewer', scope: 'subpages', owner: { id: owner.id } }]);
    expect((await manifest(stranger)).pages.map(item => item.page.id).sort()).toEqual([A, B, C].sort());
    expect((await manifest(stranger)).pages.find(item => item.page.id === B)).toEqual(summarizePage(await page(stranger, B)));
    expect((await state(A))!.visitors).toEqual([{ userId: stranger.id, displayName: '陌生人' }]);
    expect((await json<TreeDto>(owner.client.request('GET', '/api/pages/tree'))).pages.find(node => node.id === A)?.shared).toBe(true);
    expect((await json<SharesDto>(owner.client.request('GET', '/api/shares'))).outgoing).toMatchObject([{ pageId: A, accountRole: 'viewer', link: true, members: 0 }]);
    // The owner's own link leads to the page without making the owner a visitor; other accounts stay out until they open it.
    expect(await json(enter(owner, token, B))).toEqual({ pageId: B });
    expect(visitors()).toBe(1);
    expect(await incoming(viewer)).toEqual([]);
    expect(await status(get(viewer, A))).toBe(404);
  });

  it('lets everybody with the link edit when set so, combines with a member\'s own role, and ends with the setting or the link', async () => {
    await share(A, 'all', [[viewer, 'viewer']]);
    const token = await link(A);
    await accounts(A, 'editor');
    // Listed as a viewer; the link gives more once it is opened: the higher role counts.
    expect((await page(viewer, B)).access?.role).toBe('viewer');
    await enter(viewer, token);
    expect((await page(viewer, B)).access?.role).toBe('editor');
    await enter(stranger, token);
    expect(await status(save(stranger, B, [text('p', '任何帳號都能改')]))).toBe(200);
    expect((await page(owner, B)).page.content).toEqual([text('p', '任何帳號都能改')]);
    expect((await json<OfflineOpResult>(op(stranger, { type: 'row.update', databaseId: D, rowId: R, title: { base: '列', value: '連結改名' }, values: {} }))).row?.title).toBe('連結改名');
    // Still the owner's alone: structure, sub-pages, the trash, the share itself.
    expect(await status(op(stranger, { type: 'property.add', databaseId: D, propertyId: uuid(), baseVersion: 1, input: { name: '欄', type: 'text', choices: [] } }))).toBe(403);
    expect(await status(stranger.client.request('POST', '/api/pages', { json: { parentId: B, title: '子頁' } }))).toBe(404);
    expect(await status(stranger.client.request('DELETE', `/api/pages/${B}`))).toBe(404);
    expect(await status(stranger.client.request('GET', `/api/pages/${A}/share`))).toBe(404);
    // As an account, a file is readable only after opening the link.
    const file = await json<{ id: string; url: string }>(upload(owner, {}));
    await save(owner, C, [{ id: 'i', type: 'image', props: { url: file.url, name: '合成.png' }, children: [] }]);
    expect(await status(editor.client.request('GET', file.url))).toBe(404);
    expect(await status(upload(editor, { pageId: C }))).toBe(404);
    await enter(editor, token);
    expect(await status(editor.client.request('GET', file.url))).toBe(200);
    expect(await status(upload(editor, { pageId: C }))).toBe(201);
    // Leaving takes it off my list and ends my access; the link brings both back.
    expect(await status(stranger.client.request('DELETE', `/api/shares/incoming/${A}`))).toBe(204);
    expect(await incoming(stranger)).toEqual([]);
    expect(await status(get(stranger, B))).toBe(404);
    await enter(stranger, token);
    expect((await incoming(stranger)).map(item => item.pageId)).toEqual([A]);
    // The role taken away: everyone who came through the link is out at once and reads the public copy like anybody;
    // the link itself stays, and so does the listed member with their own role.
    expect((await accounts(A, null)).share).toMatchObject({ accountRole: null, visitors: [], link: { token } });
    for (const who of [stranger, editor]) {
      expect(await status(get(who, B))).toBe(404);
      expect(await incoming(who)).toEqual([]);
      expect((await manifest(who)).pages).toEqual([]);
      expect(await status(who.client.request('GET', file.url))).toBe(404);
      expect(await status(enter(who, token))).toBe(404);
      expect(await json<PublicShareDto>(peek(token, who.client))).toMatchObject({ rootId: A });
    }
    expect((await page(viewer, B)).access?.role).toBe('viewer');
    expect(visitors()).toBe(0);
    // Set again: the same address, and nobody is remembered from before.
    expect((await accounts(A, 'viewer')).share).toMatchObject({ accountRole: 'viewer', visitors: [], link: { token } });
    expect(await incoming(stranger)).toEqual([]);
    await enter(stranger, token);
    expect((await page(stranger, B)).access?.role).toBe('viewer');
    // The public link switched off: the setting and everyone who came in end with it.
    expect((await json<ShareStateDto>(owner.client.request('DELETE', `/api/pages/${A}/share/link`))).share).toMatchObject({ accountRole: null, visitors: [], link: null });
    expect([await status(get(stranger, B)), await status(enter(stranger, token)), await status(peek(token))]).toEqual([404, 404, 404]);
    expect(visitors()).toBe(0);
    // Switched on again: a new address that gives accounts nothing until the owner says so.
    const again = await link(A);
    expect(again).not.toBe(token);
    expect(await state(A)).toMatchObject({ accountRole: null, link: { token: again } });
    expect(await status(enter(stranger, again))).toBe(404);
    expect(await json<PublicShareDto>(peek(again, stranger.client))).toMatchObject({ rootId: A });
    // The trash ends the link and what it gave for good; the listed member comes back with the page.
    await accounts(A, 'editor');
    await enter(stranger, again);
    await owner.client.request('DELETE', `/api/pages/${A}`);
    expect(await status(get(stranger, B))).toBe(404);
    await owner.client.request('POST', `/api/trash/${A}/restore`);
    expect([await status(enter(stranger, again)), await status(get(stranger, B))]).toEqual([404, 404]);
    expect(await state(A)).toMatchObject({ accountRole: null, visitors: [], link: null });
    expect((await page(viewer, B)).access?.role).toBe('viewer');
  });

  it('shows the public copy to those the link does not take in, and leads the owner and listed members to the page', async () => {
    await share(A, 'page', [[viewer, 'viewer']]);
    const token = await link(A);
    expect(await state(A)).toMatchObject({ accountRole: null, link: { token } });
    // No role for accounts: a signed-in account that is not on the list reads the public copy like anybody else and gets no further.
    expect(await json<PublicShareDto>(peek(token, stranger.client))).toMatchObject({ rootId: A });
    expect(await status(enter(stranger, token))).toBe(404);
    expect(await status(get(stranger, A))).toBe(404);
    // The owner and a listed member are taken to the page itself, with the role they already have.
    for (const who of [owner, viewer]) {
      expect(await json(peek(token, who.client))).toEqual({ account: true });
      expect(await json(enter(who, token))).toEqual({ pageId: A });
    }
    expect((await page(viewer, A)).access?.role).toBe('viewer');
    expect(visitors()).toBe(0);
    // Giving accounts a role changes nothing for a visitor without one, and neither the address.
    expect((await accounts(A, 'editor')).share!.link).toMatchObject({ token });
    expect(await link(A)).toBe(token);
    expect(await state(A)).toMatchObject({ accountRole: 'editor', link: { token } });
    expect(await json<PublicShareDto>(peek(token))).toMatchObject({ rootId: A });
    expect(await status(t.client().request('GET', `/api/public/${token}/pages/${A}`))).toBe(200);
    expect(await json(peek(token, stranger.client))).toEqual({ account: true });
    expect(await json(enter(stranger, token))).toEqual({ pageId: A });
    expect((await page(stranger, A)).access?.role).toBe('editor');
    // An account that has been disabled is nobody: its session does not turn the public copy into anything else.
    await admin.client.request('PATCH', `/api/admin/users/${stranger.id}`, { json: { disabled: true } });
    expect(await json<PublicShareDto>(peek(token, stranger.client))).toMatchObject({ rootId: A });
  });
});

describe('discussions on a shared page', () => {
  const list = async (who: Person, id: string) => (await json<{ annotations: Annotation[] }>(who.client.request('GET', `/api/pages/${id}/annotations`))).annotations;
  it('names who wrote what and keeps each person\'s reactions apart', async () => {
    await share(B, 'page', [[viewer, 'viewer'], [editor, 'editor']]);
    const id = uuid();
    const created = await json<OfflineOpResult>(op(viewer, { type: 'annotation.create', pageId: B, annotationId: id, messageId: uuid(), quote: '文字', blockIds: ['p'], text: '唯讀者的留言', emoji: '👍', at: 1 }));
    expect(created.annotation).toMatchObject({ author: { id: viewer.id, name: '唯讀者' }, messages: [{ text: '唯讀者的留言', author: { id: viewer.id } }], mine: ['👍'], counts: { '👍': 1 }, canDelete: true });
    await op(owner, { type: 'annotation.comment', pageId: B, annotationId: id, messageId: uuid(), text: '擁有者回覆', at: 2 });
    await op(owner, { type: 'annotation.reaction', pageId: B, annotationId: id, emoji: '👍', on: true });
    await op(editor, { type: 'annotation.reaction', pageId: B, annotationId: id, emoji: '🎉', on: true });
    // Taking my own reaction away leaves the owner's.
    await op(viewer, { type: 'annotation.reaction', pageId: B, annotationId: id, emoji: '👍', on: false });
    const [forOwner] = await list(owner, B), [forEditor] = await list(editor, B), [forViewer] = await list(viewer, B);
    expect(forOwner).toMatchObject({ reactions: ['👍', '🎉'], mine: ['👍'], counts: { '👍': 1, '🎉': 1 }, canDelete: true });
    expect(forOwner!.messages.map(message => message.author?.name)).toEqual(['唯讀者', '擁有者']);
    expect(forEditor).toMatchObject({ mine: ['🎉'], canDelete: false });
    expect(forViewer).toMatchObject({ mine: [], canDelete: true });
    expect(await status(stranger.client.request('GET', `/api/pages/${B}/annotations`))).toBe(404);
    expect(await status(op(stranger, { type: 'annotation.comment', pageId: B, annotationId: id, messageId: uuid(), text: '陌生人', at: 3 }))).toBe(404);
    // Only the owner and whoever started a discussion delete it.
    expect(await status(op(editor, { type: 'annotation.delete', pageId: B, annotationId: id, messages: 2 }))).toBe(403);
    expect(await status(editor.client.request('DELETE', `/api/pages/${B}/annotations/${id}`, { headers: { 'if-match': `"${forEditor!.version}"` } }))).toBe(403);
    expect(await status(op(viewer, { type: 'annotation.delete', pageId: B, annotationId: id, messages: 2 }))).toBe(200);
    expect(await list(owner, B)).toEqual([]);
  });

  it('never lets a reader without edit access change the page, and limits what they can do to discussions', async () => {
    await share(B, 'page', [[viewer, 'viewer'], [editor, 'editor']]);
    await save(owner, B, [text('p', '第一段文字', { bold: true }), text('q', '第二段')]);
    const before = (await page(owner, B)).page;
    const id = uuid();
    // The discussion says it has no mark in the text; whatever else is sent along (here: blocks to store) is ignored.
    const created = await op(viewer, { type: 'annotation.create', pageId: B, annotationId: id, messageId: uuid(), quote: '文字', blockIds: ['p'], text: '這裡', at: 0, floating: true,
      anchors: [{ blockId: 'q', content: [{ type: 'text', text: '偷加的字', styles: { annotation: id, nosuchstyle: true } }] }] } as OfflineOp);
    expect((await json<OfflineOpResult>(created)).annotation).toMatchObject({ floating: true, quote: '文字', blockIds: ['p'], author: { id: viewer.id } });
    const after = (await page(owner, B)).page;
    expect([after.version, after.content, after.updatedAt]).toEqual([before.version, before.content, before.updatedAt]);
    // A date far in the past is not taken at face value.
    expect((await list(owner, B))[0]!.createdAt).toBeGreaterThan(t.clock.now - 31 * 24 * 60 * 60 * 1000);
    // Resolving hides a discussion for everybody: the starter, the owner and editors may, another reader may not.
    const theirs = uuid();
    await op(owner, { type: 'annotation.create', pageId: B, annotationId: theirs, messageId: uuid(), quote: '第二段', blockIds: ['q'], text: '擁有者的討論', at: 1 });
    expect(await status(op(viewer, { type: 'annotation.resolve', pageId: B, annotationId: theirs, resolved: true }))).toBe(403);
    const version = (await list(viewer, B)).find(item => item.id === theirs)!.version;
    expect(await status(viewer.client.request('PATCH', `/api/pages/${B}/annotations/${theirs}`, { json: { action: 'resolve', resolved: true }, headers: { 'if-match': `"${version}"` } }))).toBe(403);
    expect(await status(op(viewer, { type: 'annotation.resolve', pageId: B, annotationId: id, resolved: true }))).toBe(200);
    expect(await status(op(editor, { type: 'annotation.resolve', pageId: B, annotationId: theirs, resolved: true }))).toBe(200);
    expect(await status(op(owner, { type: 'annotation.resolve', pageId: B, annotationId: theirs, resolved: false }))).toBe(200);
    // One person cannot bury a discussion in emoji, nor use up the page's allowance of discussions.
    const emoji = ['👍', '❤️', '🎉', '😄', '🤔', '👀', '✅', '🚀', '🙏', '💡', '🔥', '😢', '😀', '😁', '😂', '🤣', '😃', '😅', '😆', '😉', '😊'];
    const answers: number[] = [];
    for (const item of emoji) answers.push(await status(op(viewer, { type: 'annotation.reaction', pageId: B, annotationId: theirs, emoji: item, on: true })));
    expect([answers.filter(code => code === 200).length, answers.at(-1)]).toEqual([20, 400]);
    expect(await status(op(owner, { type: 'annotation.reaction', pageId: B, annotationId: theirs, emoji: '😊', on: true }))).toBe(200);
    for (let n = 1; n < 100; n++) expect(await status(op(viewer, { type: 'annotation.create', pageId: B, annotationId: uuid(), messageId: uuid(), quote: '文字', blockIds: ['p'], emoji: '👍', at: 2, floating: true }))).toBe(200);
    expect(await status(op(viewer, { type: 'annotation.create', pageId: B, annotationId: uuid(), messageId: uuid(), quote: '文字', blockIds: ['p'], emoji: '👍', at: 2, floating: true }))).toBe(400);
    expect(await status(op(owner, { type: 'annotation.create', pageId: B, annotationId: uuid(), messageId: uuid(), quote: '文字', blockIds: ['p'], emoji: '👍', at: 2 }))).toBe(200);
    expect((await page(owner, B)).page.version).toBe(before.version);
  });
});

describe('attachments on a shared page', () => {
  it('gives a member\'s upload to the page owner and lets others read a file only through a page that shows it', async () => {
    await share(B, 'page', [[viewer, 'viewer'], [editor, 'editor']]);
    expect(await status(upload(viewer, { pageId: B }))).toBe(403);
    expect(await status(upload(stranger, { pageId: B }))).toBe(404);
    const id = uuid();
    const first = await upload(editor, { pageId: B, id });
    expect(first.status).toBe(201);
    const file = await json<{ id: string; url: string }>(first);
    expect(t.deps.db.get('SELECT user_id, uploaded_by FROM files WHERE id = ?', id)).toEqual({ user_id: owner.id, uploaded_by: editor.id });
    // A repeat by the same person answers with the same file; nobody else can use, or learn about, that id.
    expect(await status(upload(editor, { pageId: B, id }))).toBe(200);
    expect(await status(upload(owner, { id }))).toBe(409);
    expect(await status(upload(stranger, { id }))).toBe(409);
    const read = (who: Person) => who.client.request('GET', file.url);
    // Before the page shows it: the uploader and the owner only.
    expect(await status(read(editor))).toBe(200);
    expect(await status(read(owner))).toBe(200);
    expect(await status(read(viewer))).toBe(404);
    expect(await status(save(editor, B, [{ id: 'i', type: 'image', props: { url: file.url, name: '合成.png' }, children: [] }]))).toBe(200);
    const shown = await read(viewer);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('x-notes-user')).toBe(viewer.id);
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(await status(read(stranger))).toBe(404);
    expect(await status(t.client().request('GET', file.url))).toBe(401);
    expect(await status(viewer.client.request('DELETE', `/api/files/${id}`))).toBe(404);
    // The owner's other files stay private: one on an unshared page, and the cover of a page outside the scope.
    const hidden = await json<{ id: string; url: string }>(upload(owner, {}, '私人.png', syntheticPng(8, 8, 3)));
    await save(owner, X, [{ id: 'i', type: 'image', props: { url: hidden.url, name: '私人.png' }, children: [] }]);
    await owner.client.request('PATCH', `/api/pages/${A}`, { json: { coverFileId: hidden.id } });
    expect(await status(viewer.client.request('GET', hidden.url))).toBe(404);
    // An editor cannot claim the owner's file by sending its id either.
    expect(await status(upload(editor, { pageId: B, id: hidden.id }))).toBe(409);
    await owner.client.request('PATCH', `/api/pages/${B}`, { json: { coverFileId: hidden.id } });
    expect(await status(viewer.client.request('GET', `/api/files/${hidden.id}`))).toBe(200);
    // Losing access ends it; the uploader can still read what they added.
    await owner.client.request('DELETE', `/api/pages/${B}/share`);
    expect(await status(read(viewer))).toBe(404);
    expect(await status(read(editor))).toBe(200);
  });
});

describe('keeping shared notes on a device', () => {
  const manifest = async (who: Person) => await json<OfflineManifest>(who.client.request('GET', '/api/offline/manifest'));
  const sync = (who: Person, id: string, body: Record<string, unknown>, operationId = uuid()) =>
    who.client.request('PUT', `/api/offline/pages/${id}`, { json: { operationId, baseTitle: '乙', title: '乙', parentId: A, content: [], overwrite: false, ...body }, headers: { 'if-match': `"${body.baseVersion ?? 0}"` } });

  it('lists shared pages, databases and discussions exactly as they are served', async () => {
    await share(A, 'all', [[editor, 'editor']]);
    await op(owner, { type: 'annotation.create', pageId: C, annotationId: uuid(), messageId: uuid(), quote: '丙', blockIds: ['p'], text: '討論', at: 1 });
    const mine = await create(editor, { title: '自己的' });
    const list = await manifest(editor);
    expect(list.tree.map(node => node.id)).toEqual([mine]);
    expect(list.pages.map(item => item.page.id).sort()).toEqual([mine, A, B, C].sort());
    for (const id of [A, B, C]) expect(list.pages.find(item => item.page.id === id)).toEqual(summarizePage(await page(editor, id)));
    expect('access' in list.pages.find(item => item.page.id === mine)!).toBe(false);
    expect(list.databases.map(item => item.id)).toEqual([D]);
    expect(list.databases[0]!.stamp).toBe((await json<DatabaseSnapshotDto>(editor.client.request('GET', `/api/offline/databases/${D}`))).stamp);
    expect(list.annotations.map(item => item.pageId)).toEqual([C]);
    expect(list.shared).toMatchObject([{ pageId: A, role: 'editor' }]);
    const batch = await json<{ pages: PageResponse[] }>(editor.client.request('GET', `/api/offline/pages?ids=${[B, R, X, mine].join(',')}`));
    expect(batch.pages.map(item => item.page.id)).toEqual([B, R, mine]);
    expect(batch.pages[1]).toEqual(await page(editor, R));
    // The owner's list has no shared entries and is what it was before sharing existed.
    const own = await manifest(owner);
    expect(own.shared).toEqual([]);
    expect(own.pages.every(item => !('access' in item))).toBe(true);
    // Taken out of the share, everything of it disappears from the list.
    await owner.client.request('DELETE', `/api/pages/${A}/share/members/${editor.id}`);
    expect(await manifest(editor)).toMatchObject({ pages: [{ page: { id: mine } }], databases: [], annotations: [], shared: [] });
    expect(await manifest(stranger)).toMatchObject({ pages: [], databases: [], annotations: [], shared: [] });
  });

  it('syncs an editor\'s draft, refuses a viewer\'s, and never creates a page under somebody else\'s', async () => {
    await share(A, 'all', [[viewer, 'viewer'], [editor, 'editor']]);
    const version = (await page(owner, B)).page.version;
    expect(await status(sync(viewer, B, { baseVersion: version, content: [text('p', '唯讀者')] }))).toBe(403);
    expect(await status(sync(stranger, B, { baseVersion: version, content: [text('p', '陌生人')] }))).toBe(404);
    const operationId = uuid();
    const synced = await json<PageResponse>(sync(editor, B, { baseVersion: version, title: '乙二', content: [text('p', '離線改的')] }, operationId));
    expect(synced).toMatchObject({ page: { title: '乙二', version: version + 1, content: [text('p', '離線改的')] }, access: { role: 'editor', rootId: A } });
    expect(synced).toEqual({ ...await page(editor, B), applied: { version: version + 1, title: '乙二' } });
    // A stale base is a conflict for a member exactly as for the owner's other devices.
    expect(await status(sync(editor, B, { baseVersion: version, content: [text('p', '舊版')] }))).toBe(409);
    expect(await status(sync(editor, uuid(), { baseVersion: null, parentId: B, title: '子頁' }))).toBe(404);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE parent_id = ?', B)?.n).toBe(1);
    // Downgraded to read-only, a repeat is answered with what a reader sees now, not with the answer of the time.
    await owner.client.request('PATCH', `/api/pages/${A}/share/members/${editor.id}`, { json: { role: 'viewer' } });
    const repeated = await sync(editor, B, { baseVersion: version, title: '乙二', content: [text('p', '離線改的')] }, operationId);
    expect(repeated.status).toBe(200);
    expect(await json<PageResponse>(repeated)).toEqual({ ...await page(editor, B), applied: { version: version + 1, title: '乙二' } });
    expect((await page(editor, B)).access?.role).toBe('viewer');
    await owner.client.request('PATCH', `/api/pages/${A}/share/members/${editor.id}`, { json: { role: 'editor' } });
    // Once removed, a repeat of an answered request tells nothing: neither the stored answer nor the current state.
    const rowOp = uuid();
    expect(await status(op(editor, { type: 'row.update', databaseId: D, rowId: R, title: { base: '列', value: '改' }, values: {} }, rowOp))).toBe(200);
    await owner.client.request('DELETE', `/api/pages/${A}/share/members/${editor.id}`);
    expect(await status(sync(editor, B, { baseVersion: version, title: '乙二', content: [text('p', '離線改的')] }, operationId))).toBe(404);
    expect(await status(op(editor, { type: 'row.update', databaseId: D, rowId: R, title: { base: '列', value: '改' }, values: {} }, rowOp))).toBe(404);
  });
});

describe('a public link', () => {
  const open = (path: string, client = t.client()) => client.request('GET', `/api/public/${path}`);
  it('serves the pages its scope reaches, cleaned, and nothing else', async () => {
    const picture = await json<{ id: string; url: string }>(upload(owner, {}));
    const note = await json<{ id: string; url: string }>(upload(owner, {}, '說明.txt', new TextEncoder().encode('合成文字')));
    const discussion = uuid();
    await save(owner, A, [
      { id: 'p', type: 'paragraph', props: {}, children: [], content: [
        { type: 'text', text: '公開', styles: { annotation: discussion, bold: true } },
        { type: 'pageLink', props: { pageId: B, title: '乙' } }, { type: 'pageLink', props: { pageId: X, title: '不分享' } },
        { type: 'text', text: '/api/files/這只是文字', styles: {} }] },
      { id: 'i', type: 'image', props: { url: picture.url, name: '合成.png' }, children: [] },
      { id: 'f', type: 'file', props: { url: note.url, name: '說明.txt' }, children: [] },
    ]);
    await op(owner, { type: 'annotation.create', pageId: A, annotationId: discussion, messageId: uuid(), quote: '公開', blockIds: ['p'], text: '內部討論', at: 1 });
    await owner.client.request('PATCH', `/api/pages/${A}`, { json: { coverFileId: picture.id } });
    await share(A, 'subpages');
    const token = await link(A);
    const info = await open(token);
    expect(info.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(info.headers.get('cache-control')).toBe('no-store');
    expect(await json<PublicShareDto>(info)).toEqual({ rootId: A, scope: 'subpages', tree: [
      { id: A, parentId: null, kind: 'page', title: '甲', icon: null }, { id: B, parentId: A, kind: 'page', title: '乙', icon: null }, { id: C, parentId: B, kind: 'page', title: '丙', icon: null }] });
    const shown = await json<PublicPageDto>(open(`${token}/pages/${A}`));
    expect(Object.keys(shown.page).sort()).toEqual(['content', 'coverPosition', 'coverUrl', 'databaseId', 'fullWidth', 'icon', 'id', 'kind', 'title', 'updatedAt']);
    expect(shown.page.coverUrl).toBe(`/api/public/${token}/files/${picture.id}`);
    expect(shown.page.content).toEqual([
      { id: 'p', type: 'paragraph', props: {}, children: [], content: [
        { type: 'text', text: '公開', styles: { bold: true } },
        { type: 'pageLink', props: { pageId: B, title: '乙' } }, { type: 'text', text: UNREACHABLE_PAGE, styles: {} },
        { type: 'text', text: '/api/files/這只是文字', styles: {} }] },
      { id: 'i', type: 'image', props: { url: picture.url.replace('/api/files/', `/api/public/${token}/files/`), name: '合成.png' }, children: [] },
      { id: 'f', type: 'file', props: { url: note.url.replace('/api/files/', `/api/public/${token}/files/`), name: '說明.txt' }, children: [] },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(new RegExp(`${X}|不分享|${discussion}|內部討論|${owner.id}|擁有者`));
    expect((await json<PublicPageDto>(open(`${token}/pages/${C}`))).breadcrumbs.map(crumb => crumb.id)).toEqual([A, B, C]);
    // Files: only what a reachable page shows, with the same headers as for a signed-in reader.
    const image = await open(`${token}/files/${picture.id}/x.png`);
    expect([image.status, image.headers.get('content-type'), image.headers.get('content-disposition')?.split(';')[0], image.headers.get('x-notes-user')]).toEqual([200, 'image/png', 'inline', null]);
    const attachment = await open(`${token}/files/${note.id}`);
    expect([attachment.status, attachment.headers.get('content-disposition')?.split(';')[0], attachment.headers.get('content-security-policy')]).toEqual([200, 'attachment', 'sandbox']);
    const hidden = await json<{ id: string }>(upload(owner, {}, '私人.png', syntheticPng(8, 8, 5)));
    await save(owner, D, []).catch(() => undefined);
    await save(owner, X, [{ id: 'i', type: 'image', props: { url: `/api/files/${hidden.id}/x.png` }, children: [] }]);
    expect(await status(open(`${token}/files/${hidden.id}`))).toBe(404);
    // Outside the scope, an unknown address and a malformed one all look the same.
    const outside = await open(`${token}/pages/${D}`), unknown = await open(`${'x'.repeat(43)}/pages/${A}`);
    expect([outside.status, unknown.status]).toEqual([404, 404]);
    expect(await outside.json()).toEqual(await unknown.json());
    for (const path of [`${token}/pages/${R}`, `${token}/pages/${X}`, `${token}/pages/not-an-id`, `short/pages/${A}`, 'short']) expect(await status(open(path))).toBe(404);
    // Nothing else exists under the address: no discussions, no writes.
    expect(await status(open(`${token}/pages/${A}/annotations`))).toBe(404);
    expect(await status(t.client().request('POST', `/api/public/${token}/pages/${A}`, { json: {} }))).toBe(404);
    expect(await status(t.client().request('PUT', `/api/public/${token}`, { json: {} }))).toBe(404);
    // The token opens nothing on the signed-in API.
    expect(await status(t.client().request('GET', `/api/pages/${A}`))).toBe(401);
  });

  it('shows a shared database with its rows, and a row with its cells', async () => {
    const property = uuid();
    await op(owner, { type: 'property.add', databaseId: D, propertyId: property, baseVersion: 1, input: { name: '狀態', type: 'text', choices: [] } });
    await op(owner, { type: 'row.update', databaseId: D, rowId: R, values: { [property]: { base: null, value: '進行中' } } });
    await share(D, 'page');
    const token = await link(D);
    const database = await json<PublicPageDto>(open(`${token}/pages/${D}`));
    expect(database.database).toMatchObject({ meta: { id: D, properties: [{ id: property, name: '狀態' }] }, rows: [{ id: R, title: '列', values: { [property]: '進行中' } }] });
    const row = await json<PublicPageDto>(open(`${token}/pages/${R}`));
    expect(row).toMatchObject({ page: { id: R, kind: 'row', databaseId: D }, row: { values: { [property]: '進行中' }, properties: [{ id: property }] } });
    expect(row.breadcrumbs.map(crumb => crumb.id)).toEqual([D, R]);
    expect(await status(open(`${token}/pages/${A}`))).toBe(404);
  });

  it('stops for good when switched off, trashed or when the owner is disabled', async () => {
    await share(A, 'page');
    const first = await link(A);
    expect(await status(open(first))).toBe(200);
    await owner.client.request('DELETE', `/api/pages/${A}/share/link`);
    expect(await status(open(first))).toBe(404);
    const second = await link(A);
    expect(second).not.toBe(first);
    expect([await status(open(first)), await status(open(second))]).toEqual([404, 200]);
    // The trash takes the address away, also for a shared page somewhere below; restoring does not bring it back.
    await share(B, 'page');
    const inner = await link(B);
    await owner.client.request('DELETE', `/api/pages/${A}`);
    await owner.client.request('POST', `/api/trash/${A}/restore`);
    expect([await status(open(second)), await status(open(inner))]).toEqual([404, 404]);
    expect((await json<ShareStateDto>(owner.client.request('GET', `/api/pages/${A}/share`))).share).toMatchObject({ scope: 'page', link: null });
    const third = await link(A);
    await admin.client.request('PATCH', `/api/admin/users/${owner.id}`, { json: { disabled: true } });
    expect(await status(open(third))).toBe(404);
  });

  it('limits how fast one address may read', async () => {
    await share(A, 'page');
    const token = await link(A);
    for (let request = 0; request < 600; request++) await open(token);
    const limited = await open(token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});
