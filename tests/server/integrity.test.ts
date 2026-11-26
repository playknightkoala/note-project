import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shareWith } from '../helpers/share.ts';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import { syntheticPng } from '../helpers/png.ts';
import type { PageResponse, SessionDto, TrashItemDto } from '../../src/shared/api.ts';
import type { RowsDto } from '../../src/shared/database.ts';
import type { DatabaseSnapshotDto, OfflineOp } from '../../src/shared/offline.ts';
import type { MemberRole, ShareScope, SharesDto } from '../../src/shared/shares.ts';
import { KEPT_BACKUPS, backupFilesDir, runBackup } from '../../src/server/backup.ts';
import { openDatabase } from '../../src/server/db/driver.ts';
import type { Db } from '../../src/server/db/driver.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { resolveAccess, scopePages } from '../../src/server/services/access.ts';
import { blobPath } from '../../src/server/services/storage.ts';

/** All accounts and contents are synthetic. `admin` runs the site, `owner` owns the pages, `member` is shared with. */
interface Person { client: TestClient; id: string; email: string }
let t: TestApp, admin: Person, owner: Person, member: Person;
const uuid = () => crypto.randomUUID();
const json = async <T>(response: Response | Promise<Response>) => await (await response).json() as T;
const status = async (response: Promise<Response>) => (await response).status;
const text = (value: string) => ({ id: uuid(), type: 'paragraph', props: {}, content: [{ type: 'text', text: value, styles: {} }], children: [] });

const invite = async (expiresInHours = 24) => (await json<{ code: string }>(admin.client.request('POST', '/api/admin/invites', { json: { expiresInHours } }))).code;
async function person(name: string): Promise<Person> {
  const client = t.client(), email = `${uuid()}@example.test`;
  const code = admin ? await invite() : undefined;
  const session = await json<SessionDto>(client.register({ email, displayName: name, password: uuid(), ...(code ? { inviteCode: code } : {}) }));
  return { client, id: session.user.id, email };
}
const create = async (who: Person, input: Record<string, unknown>) => (await json<PageResponse>(who.client.request('POST', '/api/pages', { json: input }))).page.id;
const version = (id: string) => t.deps.db.get<{ version: number }>('SELECT version FROM pages WHERE id = ?', id)!.version;
const save = (who: Person, id: string, content: unknown[]) => who.client.request('PUT', `/api/pages/${id}/content`, { json: { content }, headers: { 'if-match': `"${version(id)}"` } });
const op = (who: Person, input: OfflineOp) => who.client.request('POST', '/api/offline/ops', { json: { operationId: uuid(), force: false, op: input } });
const addRow = async (who: Person, databaseId: string, title: string) => {
  const rowId = uuid();
  expect(await status(op(who, { type: 'row.create', databaseId, rowId, title, values: {} }))).toBe(200);
  return rowId;
};
const trash = (who: Person, id: string) => who.client.request('DELETE', `/api/pages/${id}`);
const trashItems = async (who: Person) => (await json<{ items: TrashItemDto[] }>(who.client.request('GET', '/api/trash'))).items;
const exists = (id: string) => !!t.deps.db.get('SELECT 1 FROM pages WHERE id = ?', id);
const share = async (id: string, scope: ShareScope, role: MemberRole = 'viewer') => {
  expect(await status(owner.client.request('PUT', `/api/pages/${id}/share`, { json: { scope } }))).toBe(200);
  await shareWith(owner.client, member.client, id, member.email, role);
};

beforeEach(async () => {
  t = createTestApp();
  admin = undefined as unknown as Person;
  admin = await person('站台管理者');
  owner = await person('擁有者'); member = await person('成員');
});
afterEach(() => t.close());

describe('permanently deleting from the trash', () => {
  it('leaves a page that was trashed on its own in the trash when its parent is deleted', async () => {
    const parent = await create(owner, { title: '父頁' });
    const sibling = await create(owner, { title: '一起刪除的子頁', parentId: parent });
    const child = await create(owner, { title: '先刪除的子頁', parentId: parent });
    const grand = await create(owner, { title: '孫頁', parentId: child });
    await trash(owner, child);
    await trash(owner, parent);
    expect((await trashItems(owner)).map(item => [item.title, item.descendantCount, item.alsoDeletedCount]).sort())
      .toEqual([['先刪除的子頁', 1, 0], ['父頁', 1, 0]]);

    expect(await status(owner.client.request('DELETE', `/api/trash/${parent}`))).toBe(204);
    expect([exists(parent), exists(sibling), exists(child), exists(grand)]).toEqual([false, false, true, true]);
    expect((await trashItems(owner)).map(item => item.id)).toEqual([child]);
    // Its parent is gone: it comes back at the top level, with what was trashed with it.
    const restored = await json<{ page: { id: string; parentId: string | null } }>(owner.client.request('POST', `/api/trash/${child}/restore`));
    expect(restored.page).toMatchObject({ id: child, parentId: null });
    expect((await json<PageResponse>(owner.client.request('GET', `/api/pages/${grand}`))).page.parentId).toBe(child);
  });

  it('counts the rows trashed on their own that go with their database, and says so in the list', async () => {
    const holder = await create(owner, { title: '放資料庫的頁面' });
    const database = await create(owner, { title: '資料庫', parentId: holder, kind: 'database' });
    const kept = await addRow(owner, database, '留著的列'), gone = await addRow(owner, database, '先刪除的列');
    await trash(owner, gone);
    await trash(owner, holder);
    const items = await trashItems(owner);
    // holder + database + the row still in it went together; the row trashed before is listed on its own.
    expect(items.find(item => item.id === holder)).toMatchObject({ descendantCount: 2, alsoDeletedCount: 1 });
    expect(items.find(item => item.id === gone)).toMatchObject({ descendantCount: 0, alsoDeletedCount: 0 });
    // A row cannot come back without its database, so it is not left behind as an item that can never be restored.
    expect(await status(owner.client.request('POST', `/api/trash/${gone}/restore`))).toBe(409);
    expect(await status(owner.client.request('DELETE', `/api/trash/${holder}`))).toBe(204);
    expect([exists(holder), exists(database), exists(kept), exists(gone)]).toEqual([false, false, false, false]);
    expect(await trashItems(owner)).toEqual([]);
  });

  it('counts a row that was trashed on its own once, whatever went to the trash with it', async () => {
    const database = await create(owner, { title: '資料庫', kind: 'database' });
    const row = await addRow(owner, database, '有子頁面的列');
    const below = await create(owner, { title: '列底下的頁面', parentId: row });
    expect(await json(trash(owner, row))).toEqual({ trashedCount: 2 });
    await trash(owner, database);
    const items = await trashItems(owner);
    expect(items.map(item => item.id).sort()).toEqual([database, row].sort());
    expect(items.find(item => item.id === row)).toMatchObject({ descendantCount: 1, alsoDeletedCount: 0 });
    // One item of the list goes along (the row), not two: the page below it is part of that item.
    expect(items.find(item => item.id === database)).toMatchObject({ descendantCount: 0, alsoDeletedCount: 1 });
    expect(await status(owner.client.request('DELETE', `/api/trash/${database}`))).toBe(204);
    expect([exists(database), exists(row), exists(below)]).toEqual([false, false, false]);
  });

  it('reports how many pages emptying the trash removed, nested ones included', async () => {
    const parent = await create(owner, { title: '父頁' });
    const child = await create(owner, { title: '子頁', parentId: parent });
    await create(owner, { title: '孫頁', parentId: child });
    await trash(owner, child);
    await trash(owner, parent);
    expect(await json(owner.client.request('DELETE', '/api/trash'))).toEqual({ deleted: 3 });
  });
});

describe('restoring a version of a row', () => {
  it('brings back the text and leaves the name that was changed in the database alone', async () => {
    const database = await create(owner, { title: '資料庫', kind: 'database' });
    const row = await addRow(owner, database, '舊名稱');
    expect(await status(save(owner, row, [text('第一版')]))).toBe(200);
    t.clock.now += 11 * 60 * 1000;
    expect(await status(save(owner, row, [text('第二版')]))).toBe(200);
    const versions = (await json<{ versions: { id: string; version: number }[] }>(owner.client.request('GET', `/api/pages/${row}/versions`))).versions;
    const first = versions.find(item => item.version === 2)!;
    expect(await status(owner.client.request('PATCH', `/api/rows/${row}/values`, { json: { title: '新名稱', values: {} }, headers: { 'if-match': '"1"' } }))).toBe(200);

    const restored = await owner.client.request('POST', `/api/pages/${row}/versions/${first.id}/restore`, { headers: { 'if-match': `"${version(row)}"` } });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ title: '新名稱' });
    const page = (await json<PageResponse>(owner.client.request('GET', `/api/pages/${row}`))).page;
    expect(page.title).toBe('新名稱');
    expect(JSON.stringify(page.content)).toContain('第一版');
  });

  it('still restores the title of an ordinary page with its text', async () => {
    const page = await create(owner, { title: '原標題' });
    expect(await status(save(owner, page, [text('第一版')]))).toBe(200);
    t.clock.now += 11 * 60 * 1000;
    expect(await status(owner.client.request('PATCH', `/api/pages/${page}`, { json: { title: '新標題' } }))).toBe(200);
    expect(await status(save(owner, page, [text('第二版')]))).toBe(200);
    const versions = (await json<{ versions: { id: string; version: number; title: string }[] }>(owner.client.request('GET', `/api/pages/${page}/versions`))).versions;
    const first = versions.find(item => item.title === '原標題')!;
    const restored = await owner.client.request('POST', `/api/pages/${page}/versions/${first.id}/restore`, { headers: { 'if-match': `"${version(page)}"` } });
    expect(await restored.json()).toMatchObject({ title: '原標題' });
  });
});

describe('listing a database', () => {
  it('lists rows and gives a device its copy without reading what is written inside the rows', async () => {
    const database = await create(owner, { title: '資料庫', kind: 'database' });
    const row = await addRow(owner, database, '有內文的列');
    expect(await status(save(owner, row, [text('列裡面的長篇內文')]))).toBe(200);
    const listed = await json<RowsDto>(owner.client.request('GET', `/api/databases/${database}/rows`));
    expect(listed.rows).toEqual([expect.objectContaining({ id: row, title: '有內文的列' })]);
    const snapshot = await json<DatabaseSnapshotDto>(owner.client.request('GET', `/api/offline/databases/${database}`));
    expect(snapshot.pages).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('列裡面的長篇內文');
    // The summary a device compares with must be the one the row's own page gives.
    const full = await json<{ pages: PageResponse[] }>(owner.client.request('GET', `/api/offline/pages?ids=${row}`));
    expect(JSON.stringify(full.pages[0]!.page.content)).toContain('列裡面的長篇內文');
    expect(snapshot.pages[0]!.page).toMatchObject({ id: row, version: full.pages[0]!.page.version, updatedAt: full.pages[0]!.page.updatedAt });
  });
});

describe('registering with an invite', () => {
  it('refuses an invite that ran out while the request was being handled', async () => {
    const code = await invite(1);
    const original = t.deps.db.transaction;
    // The hour passes between the first check and the transaction that redeems the invite.
    t.deps.db.transaction = fn => { t.clock.now += 2 * 60 * 60 * 1000; return original(fn); };
    const late = t.client();
    const response = await late.register({ email: `${uuid()}@example.test`, displayName: '遲到的人', password: uuid(), inviteCode: code });
    t.deps.db.transaction = original;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invite_invalid' } });
    expect(Number(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n)).toBe(3);
  });
});

describe('what a share reaches', () => {
  it('lists and admits the same pages at the deepest level', async () => {
    const root = await create(owner, { title: '根' });
    const chain = [root];
    for (let depth = 1; depth <= 65; depth++) chain.push(await create(owner, { title: `第 ${depth} 層`, parentId: chain[depth - 1] }));
    await share(root, 'subpages');
    const listed = new Set(scopePages(t.deps.db, owner.id, root, 'subpages').map(page => page.id));
    const admitted = (id: string) => { try { resolveAccess(t.deps.db, member.id, id); return true; } catch { return false; } };
    for (const depth of [63, 64, 65]) expect([depth, listed.has(chain[depth]!), admitted(chain[depth]!)]).toEqual([depth, depth <= 64, depth <= 64]);
    expect(await status(member.client.request('GET', `/api/pages/${chain[64]}`))).toBe(200);
    expect(await status(member.client.request('GET', `/api/pages/${chain[65]}`))).toBe(404);
  });

  it('reaches the rows of a database on the deepest level, in the list and when one is opened', async () => {
    const root = await create(owner, { title: '根' });
    const chain = [root];
    for (let depth = 1; depth <= 63; depth++) chain.push(await create(owner, { title: `第 ${depth} 層`, parentId: chain[depth - 1] }));
    const database = await create(owner, { title: '第 64 層的資料庫', parentId: chain[63], kind: 'database' });
    const row = await addRow(owner, database, '第 65 層的列');
    const below = await create(owner, { title: '列底下的頁面', parentId: row });
    await share(root, 'all');
    const listed = new Set(scopePages(t.deps.db, owner.id, root, 'all').map(page => page.id));
    expect([listed.has(database), listed.has(row), listed.has(below)]).toEqual([true, true, false]);
    expect((await json<RowsDto>(member.client.request('GET', `/api/databases/${database}/rows`))).rows.map(item => item.id)).toEqual([row]);
    expect(await status(member.client.request('GET', `/api/pages/${row}`))).toBe(200);
    expect(await status(member.client.request('GET', `/api/pages/${below}`))).toBe(404);
  });

  it('lists a share on a page below a row on its own: the tree of the database does not lead to it', async () => {
    const database = await create(owner, { title: '資料庫', kind: 'database' });
    const row = await addRow(owner, database, '列');
    const below = await create(owner, { title: '列底下的頁面', parentId: row });
    await share(database, 'all');
    await share(below, 'page', 'editor');
    const incoming = (await json<SharesDto>(member.client.request('GET', '/api/shares'))).incoming;
    expect(incoming.map(item => item.pageId).sort()).toEqual([database, below].sort());
    expect(incoming.find(item => item.pageId === below)).toMatchObject({ role: 'editor', tree: [expect.objectContaining({ id: below, parentId: null })] });
  });

  it('keeps a database reachable from the list when a share inside another one is what grants it', async () => {
    const outer = await create(owner, { title: '外層' });
    const inner = await create(owner, { title: '內層', parentId: outer });
    const database = await create(owner, { title: '內層的資料庫', parentId: inner, kind: 'database' });
    const elsewhere = await create(owner, { title: '外層的資料庫', parentId: outer, kind: 'database' });
    await share(outer, 'subpages');
    await share(inner, 'all', 'editor');
    expect(await status(member.client.request('GET', `/api/pages/${database}`))).toBe(200);
    expect(await status(member.client.request('GET', `/api/pages/${elsewhere}`))).toBe(404);

    const incoming = (await json<SharesDto>(member.client.request('GET', '/api/shares'))).incoming;
    expect(incoming.map(item => item.pageId)).toEqual([outer]);
    const tree = incoming[0]!.tree;
    expect(tree.map(node => node.id).sort()).toEqual([outer, inner, database].sort());
    expect(tree.find(node => node.id === database)).toMatchObject({ parentId: inner, kind: 'database' });
    expect(tree.find(node => node.id === inner)).toMatchObject({ parentId: outer, hasChildren: true });
  });
});

describe('backups', () => {
  const upload = async (bytes: Uint8Array) => {
    const form = new FormData();
    form.append('file', new File([bytes], '合成.png', { type: 'image/png' }));
    return await json<{ id: string; sha256: string }>(owner.client.request('POST', '/api/files', { body: form }));
  };
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

  it('restores an attachment that was deleted after the snapshot was taken', async () => {
    const bytes = syntheticPng(12, 7);
    const file = await upload(bytes);
    const result = await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now));
    expect(result).toMatchObject({ kept: 1, files: 1, missingFiles: 0 });
    expect(await status(owner.client.request('DELETE', `/api/files/${file.id}`))).toBe(204);
    expect(existsSync(blobPath(t.dataDir, file.sha256))).toBe(false);

    // Restore as docs/DEPLOY.md describes: the snapshot becomes the database, its attachments go back into files/.
    const restoredDir = mkdtempSync(join(tmpdir(), 'notes-restore-'));
    try {
      cpSync(result.backup, join(restoredDir, 'notes.sqlite'));
      cpSync(backupFilesDir(result.backup), join(restoredDir, 'files'), { recursive: true });
      const restored = openDatabase(join(restoredDir, 'notes.sqlite'));
      try {
        migrate(restored);
        const row = restored.get<{ sha256: string; size: number }>('SELECT sha256, size FROM files WHERE id = ?', file.id)!;
        expect(row).toMatchObject({ sha256: file.sha256, size: bytes.byteLength });
        expect(sha(blobPath(restoredDir, row.sha256))).toBe(file.sha256);
      } finally { restored.close(); }
    } finally { rmSync(restoredDir, { recursive: true, force: true }); }
    // Opening the snapshot to read its file list leaves nothing beside it.
    expect(readdirSync(join(t.dataDir, 'backups')).sort()).toEqual([result.backup, backupFilesDir(result.backup)].map(path => path.split('/').pop()).sort());
  });

  it('keeps the newest snapshots with their attachments and drops the rest', async () => {
    const file = await upload(syntheticPng(5, 5));
    const results = [];
    for (let day = 0; day < KEPT_BACKUPS + 2; day++) results.push(await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now + day * 86_400_000)));
    expect(results.at(-1)).toMatchObject({ kept: KEPT_BACKUPS });
    const names = readdirSync(join(t.dataDir, 'backups'));
    expect(names.filter(name => name.endsWith('.sqlite'))).toHaveLength(KEPT_BACKUPS);
    expect(names.filter(name => name.endsWith('.files'))).toHaveLength(KEPT_BACKUPS);
    for (const gone of results.slice(0, 2)) expect([existsSync(gone.backup), existsSync(backupFilesDir(gone.backup))]).toEqual([false, false]);
    const kept = join(backupFilesDir(results.at(-1)!.backup), file.sha256.slice(0, 2), file.sha256.slice(2, 4), file.sha256);
    expect(sha(kept)).toBe(file.sha256);
  });

  it('keeps a snapshot that misses attachments apart, so it never takes the place of a complete one', async () => {
    const day = (n: number) => new Date(t.clock.now + n * 86_400_000);
    const file = await upload(syntheticPng(9, 4));
    const complete = await runBackup(t.deps.db, t.dataDir, day(0));
    rmSync(blobPath(t.dataDir, file.sha256));
    // Lost before these runs and still referenced by the notes: taking the snapshot again would not bring it back.
    const first = await runBackup(t.deps.db, t.dataDir, day(1));
    expect(first).toMatchObject({ files: 1, missingFiles: 1, attempts: 1, kept: 1, keptIncomplete: 1 });
    expect(first.backup).toMatch(/\.incomplete\.sqlite$/);
    for (let n = 2; n <= 6; n++) expect(await runBackup(t.deps.db, t.dataDir, day(n))).toMatchObject({ missingFiles: 1, kept: 1, keptIncomplete: n });
    // The attachment is given up in the notes, and the next backup is complete again. Six snapshots were taken
    // since the last complete one; it is still there, with the file.
    expect(await status(owner.client.request('DELETE', `/api/files/${file.id}`))).toBe(204);
    expect(await runBackup(t.deps.db, t.dataDir, day(7))).toMatchObject({ files: 0, missingFiles: 0, kept: 2, keptIncomplete: 6 });
    expect(existsSync(complete.backup)).toBe(true);
    expect(sha(join(backupFilesDir(complete.backup), file.sha256.slice(0, 2), file.sha256.slice(2, 4), file.sha256))).toBe(file.sha256);
    // Complete snapshots fill their number: the incomplete ones from before the oldest of them go with their time.
    let last = first;
    for (let n = 8; n <= 13; n++) last = await runBackup(t.deps.db, t.dataDir, day(n));
    expect(last).toMatchObject({ kept: KEPT_BACKUPS, keptIncomplete: 0 });
    expect([existsSync(complete.backup), existsSync(first.backup), existsSync(backupFilesDir(first.backup))]).toEqual([false, false, false]);
  });

  it('keeps no more incomplete snapshots than complete ones', async () => {
    const file = await upload(syntheticPng(9, 4));
    rmSync(blobPath(t.dataDir, file.sha256));
    let last;
    for (let n = 0; n < KEPT_BACKUPS + 2; n++) last = await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now + n * 86_400_000));
    expect(last).toMatchObject({ kept: 0, keptIncomplete: KEPT_BACKUPS });
    expect(readdirSync(join(t.dataDir, 'backups')).filter(name => name.endsWith('.sqlite'))).toHaveLength(KEPT_BACKUPS);
  });

  it('runs one backup at a time', async () => {
    let release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let started = () => {};
    const underWay = new Promise<void>(resolve => { started = resolve; });
    const slow: Db = { ...t.deps.db, backup: async destination => { started(); await waiting; await t.deps.db.backup(destination); } };
    const first = runBackup(slow, t.dataDir, new Date(t.clock.now));
    await underWay;
    await expect(runBackup(t.deps.db, t.dataDir, new Date(t.clock.now + 1000))).rejects.toThrow('另一個備份正在執行');
    release();
    expect(await first).toMatchObject({ kept: 1 });
    // The first run was not disturbed, and the next one is free to go.
    expect(await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now + 2000))).toMatchObject({ kept: 2 });
    await expect(runBackup(t.deps.db, t.dataDir, new Date(t.clock.now + 2000))).rejects.toThrow('已經存在');
  });

  it('takes the snapshot again when an attachment it caught was deleted before it could be kept', async () => {
    const stays = await upload(syntheticPng(6, 6));
    let taken = 0;
    const db: Db = { ...t.deps.db, backup: async destination => {
      // Uploaded after the first look at the files, caught by the snapshot, deleted before the second look.
      const passing = ++taken === 1 ? await upload(syntheticPng(31, 3)) : undefined;
      await t.deps.db.backup(destination);
      if (passing) expect(await status(owner.client.request('DELETE', `/api/files/${passing.id}`))).toBe(204);
    } };
    const result = await runBackup(db, t.dataDir, new Date(t.clock.now));
    expect(result).toMatchObject({ attempts: 2, files: 1, missingFiles: 0, kept: 1 });
    const snapshot = openDatabase(result.backup);
    try { expect(snapshot.all<{ sha256: string }>('SELECT sha256 FROM files').map(row => row.sha256)).toEqual([stays.sha256]); } finally { snapshot.close(); }
    const kept = backupFilesDir(result.backup);
    expect(readdirSync(kept, { recursive: true }).filter(name => String(name).length === 64 + 6)).toEqual([join(stays.sha256.slice(0, 2), stays.sha256.slice(2, 4), stays.sha256)]);
    // Nothing of the first attempt is left beside the finished backup.
    expect(readdirSync(join(t.dataDir, 'backups')).sort()).toEqual([result.backup, kept].map(path => path.split('/').pop()).sort());
  });

  it('never publishes a snapshot that could not be finished', async () => {
    await upload(syntheticPng(4, 4));
    const db: Db = { ...t.deps.db, backup: async destination => { writeFileSync(destination, 'half a database'); throw new Error('disk full'); } };
    await expect(runBackup(db, t.dataDir, new Date(t.clock.now))).rejects.toThrow('disk full');
    expect(readdirSync(join(t.dataDir, 'backups'))).toEqual([]);
  });

  it('says what is wrong when the lock cannot be used, instead of blaming another backup', async () => {
    // Something that is not a database where the lock belongs.
    mkdirSync(join(t.dataDir, 'tmp', 'backup.lock'), { recursive: true });
    const failed = await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now)).then(() => undefined, (error: unknown) => error as Error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed!.message).not.toContain('另一個備份');
    expect(existsSync(join(t.dataDir, 'backups')) ? readdirSync(join(t.dataDir, 'backups')) : []).toEqual([]);
  });

  it('clears what an interrupted run left behind, and nothing that is not its own', async () => {
    const directory = join(t.dataDir, 'backups');
    const leftovers = ['notes-2020-01-01T00-00-00-000Z.files', 'notes-2020-01-03T00-00-00-000Z.files.partial'];
    const partial = 'notes-2020-01-02T00-00-00-000Z.sqlite.partial';
    for (const name of [...leftovers, 'mine.files']) mkdirSync(join(directory, name), { recursive: true });
    writeFileSync(join(directory, partial), 'half a database');
    // Only one backup runs at a time, so whatever is unfinished belongs to a run that has ended.
    const result = await runBackup(t.deps.db, t.dataDir, new Date(t.clock.now));
    expect([...leftovers, partial, 'mine.files'].map(name => existsSync(join(directory, name)))).toEqual([false, false, false, true]);
    expect(result).toMatchObject({ kept: 1, missingFiles: 0 });
  });
});
