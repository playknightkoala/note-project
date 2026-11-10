import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { PageResponse } from '../../src/shared/api.ts';
import type { Annotation } from '../../src/shared/annotations.ts';
import type { DatabaseDto, DatabaseRow } from '../../src/shared/database.ts';
import type { DatabaseSnapshotDto, OfflineManifest, OfflineOp, OfflineOpResult } from '../../src/shared/offline.ts';
import { syntheticPng } from '../helpers/png.ts';

let t: TestApp, client: TestClient, databaseId: string;
const uuid = () => crypto.randomUUID();
const send = (op: OfflineOp, options: { operationId?: string; force?: boolean; who?: TestClient } = {}) =>
  (options.who ?? client).request('POST', '/api/offline/ops', { json: { operationId: options.operationId ?? uuid(), force: options.force ?? false, op } });
const ok = async (op: OfflineOp, options: Parameters<typeof send>[1] = {}) => {
  const response = await send(op, options);
  expect(response.status).toBe(200);
  return await response.json() as OfflineOpResult;
};
const meta = async () => await (await client.request('GET', `/api/databases/${databaseId}`)).json() as DatabaseDto;
const manifest = async (who = client) => await (await who.request('GET', '/api/offline/manifest')).json() as OfflineManifest;
const stranger = async () => {
  const invitation = await (await client.request('POST', '/api/admin/invites', { json: { expiresInHours: 24 } })).json() as { code: string };
  const other = t.client();
  await other.register({ email: `${uuid()}@example.test`, displayName: '另一位', password: uuid(), inviteCode: invitation.code });
  return other;
};
beforeEach(async () => {
  t = createTestApp(); client = t.client();
  await client.register({ email: `${uuid()}@example.test`, displayName: '合成測試', password: uuid() });
  databaseId = (await (await client.request('POST', '/api/pages', { json: { kind: 'database', title: '合成資料庫' } })).json() as PageResponse).page.id;
});
afterEach(() => t.close());

it('creates a row once under the id the device chose, even when the operation is sent again as a new one', async () => {
  const rowId = uuid(), operationId = uuid();
  const op: OfflineOp = { type: 'row.create', databaseId, rowId, title: '離線新增', values: {} };
  const first = await ok(op, { operationId });
  expect(first.row).toMatchObject({ id: rowId, databaseId, title: '離線新增' });
  expect(await ok(op, { operationId })).toEqual(first);
  expect((await ok(op)).row?.id).toBe(rowId);
  expect(t.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE kind = 'row'")?.n).toBe(1);
  const page = await (await client.request('GET', `/api/pages/${rowId}`)).json() as PageResponse;
  expect(page.page).toMatchObject({ kind: 'row', databaseId, version: 1 });
  // An id that already names something else is refused instead of being overwritten.
  expect((await send({ ...op, rowId: databaseId })).status).toBe(409);
});

it('merges changes to different cells and reports only a cell changed on both sides', async () => {
  const textId = uuid(), numberId = uuid(), rowId = uuid();
  let version = (await meta()).version;
  for (const [propertyId, type] of [[textId, 'text'], [numberId, 'number']] as const) {
    version = (await ok({ type: 'property.add', databaseId, propertyId, baseVersion: version, input: { name: type, type, choices: [] } })).database!.version;
  }
  await ok({ type: 'row.create', databaseId, rowId, title: '列', values: { [textId]: '原文' } });
  // Another device changes the number while this one, offline, changes the text: no conflict.
  await ok({ type: 'row.update', databaseId, rowId, values: { [numberId]: { base: null, value: 7 } } });
  const merged = await ok({ type: 'row.update', databaseId, rowId, values: { [textId]: { base: '原文', value: '手機改的' } } });
  expect(merged.row?.values).toEqual({ [textId]: '手機改的', [numberId]: 7 });
  // The same cell from a stale base is a conflict that names the cell and changes nothing, title included.
  const stale: OfflineOp = { type: 'row.update', databaseId, rowId, title: { base: '列', value: '新名稱' }, values: { [textId]: { base: '原文', value: '另一台改的' } } };
  const conflict = await send(stale);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: 'version_conflict', message: expect.stringContaining('text'), details: { current: { [textId]: '手機改的' } } } });
  expect((await (await client.request('GET', `/api/rows/${rowId}`)).json() as DatabaseRow).title).toBe('列');
  // The user's explicit choice applies it; repeating a change that is already there is not a conflict.
  expect((await ok(stale, { force: true })).row).toMatchObject({ title: '新名稱', values: { [textId]: '另一台改的', [numberId]: 7 } });
  expect((await ok(stale)).row?.title).toBe('新名稱');
  // Clearing a cell and an invalid value.
  expect((await ok({ type: 'row.update', databaseId, rowId, values: { [numberId]: { base: 7, value: null } } })).row?.values).toEqual({ [textId]: '另一台改的' });
  // An unticked checkbox is the same whether it was never set or set to false elsewhere.
  const doneId = uuid();
  await ok({ type: 'property.add', databaseId, propertyId: doneId, baseVersion: (await meta()).version, input: { name: '完成', type: 'checkbox', choices: [] } });
  await ok({ type: 'row.update', databaseId, rowId, values: { [doneId]: { base: null, value: true } } });
  await ok({ type: 'row.update', databaseId, rowId, values: { [doneId]: { base: true, value: false } } });
  expect((await ok({ type: 'row.update', databaseId, rowId, values: { [doneId]: { base: null, value: true } } })).row?.values[doneId]).toBe(true);
  expect((await send({ type: 'row.update', databaseId, rowId, values: { [numberId]: { base: null, value: '不是數字' } } })).status).toBe(400);
  expect((await send({ type: 'row.update', databaseId, rowId, values: { [uuid()]: { base: null, value: 'x' } } })).status).toBe(404);
});

it('checks structure changes against the version they were made on and repeats them safely', async () => {
  const before = await meta();
  const propertyId = uuid(), viewId = uuid(), operationId = uuid();
  const add: OfflineOp = { type: 'property.add', databaseId, propertyId, baseVersion: before.version, input: { name: '狀態', type: 'select', choices: [{ id: uuid(), label: '進行中', color: 'blue' }] } };
  const added = await ok(add, { operationId });
  expect(added.database).toMatchObject({ version: before.version + 1, properties: [{ id: propertyId, name: '狀態' }] });
  // The answer was lost: the same operation again changes nothing and returns the current structure.
  expect(await ok(add, { operationId })).toEqual(added);
  expect((await meta()).version).toBe(before.version + 1);
  // A change made on the old structure is a conflict until the user decides to apply it anyway.
  const view: OfflineOp = { type: 'view.add', databaseId, viewId, baseVersion: before.version, input: { name: '看板', type: 'board', config: { sorts: [], filters: [], groupBy: propertyId } } };
  expect((await send(view)).status).toBe(409);
  const forced = await ok(view, { force: true });
  expect(forced.database?.views.find(item => item.id === viewId)).toMatchObject({ name: '看板', type: 'board', config: { groupBy: propertyId } });
  const current = forced.database!.version;
  const renamed = await ok({ type: 'view.update', databaseId, viewId, baseVersion: current, input: { name: '進度', type: 'board', config: { sorts: [], filters: [], groupBy: propertyId } } });
  expect(renamed.database?.views.find(item => item.id === viewId)?.name).toBe('進度');
  const changed = await ok({ type: 'property.update', databaseId, propertyId, baseVersion: current + 1, input: { name: '進度', type: 'text', choices: [] } });
  expect(changed.database?.views.find(item => item.id === viewId)?.config.groupBy).toBeUndefined();
  expect((await ok({ type: 'view.delete', databaseId, viewId, baseVersion: current + 2 })).database?.views).toHaveLength(1);
  expect((await ok({ type: 'property.delete', databaseId, propertyId, baseVersion: current + 3 })).database?.properties).toEqual([]);
  expect((await send({ type: 'view.delete', databaseId, viewId: before.views[0]!.id, baseVersion: current + 4 })).status).toBe(409);
});

it('keeps discussions written offline: repeatable, appended in order, without version conflicts', async () => {
  const pageId = (await (await client.request('POST', '/api/pages', { json: { title: '筆記' } })).json() as PageResponse).page.id;
  const annotationId = uuid(), messageId = uuid(), written = t.clock.now - 60_000;
  const create: OfflineOp = { type: 'annotation.create', pageId, annotationId, messageId, quote: '選取文字', blockIds: ['b1'], text: '離線留言', at: written };
  const created = await ok(create);
  expect(created.annotation).toMatchObject({ id: annotationId, quote: '選取文字', createdAt: written, messages: [{ id: messageId, text: '離線留言', createdAt: written }] });
  expect((await ok(create)).annotation?.messages).toHaveLength(1);
  // A reply from another device in between does not make the offline reply conflict.
  await client.request('PATCH', `/api/pages/${pageId}/annotations/${annotationId}`, { json: { action: 'comment', text: '電腦的回覆' }, headers: { 'if-match': '"1"' } });
  const replyId = uuid();
  const reply: OfflineOp = { type: 'annotation.comment', pageId, annotationId, messageId: replyId, text: '手機的回覆', at: t.clock.now + 999_999 };
  const replied = await ok(reply);
  expect(replied.annotation?.messages.map(message => message.text)).toEqual(['離線留言', '電腦的回覆', '手機的回覆']);
  expect(replied.annotation?.messages.at(-1)?.createdAt).toBe(t.clock.now);
  expect((await ok(reply)).annotation?.messages).toHaveLength(3);
  // Reactions state what they mean, so a repeat does not toggle them back.
  const react = (on: boolean): OfflineOp => ({ type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on });
  expect((await ok(react(true))).annotation?.reactions).toEqual(['👍']);
  expect((await ok(react(true))).annotation?.reactions).toEqual(['👍']);
  expect((await ok(react(false))).annotation?.reactions).toEqual([]);
  expect((await ok({ type: 'annotation.resolve', pageId, annotationId, resolved: true })).annotation?.resolved).toBe(true);
  const list = await (await client.request('GET', `/api/pages/${pageId}/annotations`)).json() as { annotations: Annotation[] };
  expect(list.annotations).toHaveLength(1);
  // Deleting takes every comment along, so a device that has not seen the latest reply is told instead of obeyed.
  const remove = (messages: number): OfflineOp => ({ type: 'annotation.delete', pageId, annotationId, messages });
  const unseen = await send(remove(2));
  expect(unseen.status).toBe(409);
  expect(await unseen.json()).toMatchObject({ error: { code: 'version_conflict' } });
  expect((await (await client.request('GET', `/api/pages/${pageId}/annotations`)).json() as { annotations: Annotation[] }).annotations[0]?.messages).toHaveLength(3);
  // Having seen them all (or confirming explicitly) deletes; deleting twice is fine; a reply afterwards is reported, not recreated.
  expect(await ok(remove(3))).toEqual({ deletedId: annotationId });
  expect(await ok(remove(0))).toEqual({ deletedId: annotationId });
  const forced = uuid();
  await ok({ ...create, annotationId: forced, messageId: uuid() });
  await ok({ type: 'annotation.comment', pageId, annotationId: forced, messageId: uuid(), text: '沒看過的回覆', at: 1 });
  expect(await ok({ type: 'annotation.delete', pageId, annotationId: forced, messages: 1 }, { force: true })).toEqual({ deletedId: forced });
  expect((await send({ ...reply, messageId: uuid() })).status).toBe(404);
  expect((await send({ ...create, pageId: databaseId, annotationId: uuid() })).status).toBe(404);
});

it('requires authentication and CSRF, validates input and never touches another account', async () => {
  const rowId = uuid();
  const op: OfflineOp = { type: 'row.create', databaseId, rowId, title: '列', values: {} };
  expect((await send(op, { who: t.client() })).status).toBe(401);
  expect((await client.request('POST', '/api/offline/ops', { json: { operationId: uuid(), op }, csrf: false })).status).toBe(403);
  expect((await client.request('POST', '/api/offline/ops', { json: { operationId: uuid(), op }, origin: 'https://evil.example' })).status).toBe(403);
  expect((await client.request('POST', '/api/offline/ops', { json: { operationId: 'x', op } })).status).toBe(400);
  expect((await client.request('POST', '/api/offline/ops', { json: { operationId: uuid(), op: { type: 'row.drop', databaseId } } })).status).toBe(400);
  const operationId = uuid();
  await ok(op, { operationId });
  const other = await stranger();
  // Neither a fresh operation nor a replay of the owner's operation id reaches the owner's data.
  expect((await send(op, { who: other })).status).toBe(404);
  expect((await send(op, { who: other, operationId })).status).toBe(404);
  expect((await send({ type: 'row.update', databaseId, rowId, title: { base: '列', value: '入侵' }, values: {} }, { who: other, force: true })).status).toBe(404);
  expect((await send({ type: 'property.add', databaseId, propertyId: uuid(), baseVersion: 1, input: { name: 'x', type: 'text', choices: [] } }, { who: other, force: true })).status).toBe(404);
  expect((await other.request('GET', `/api/offline/databases/${databaseId}`)).status).toBe(404);
  expect((await (await other.request('GET', `/api/offline/pages?ids=${rowId}`)).json() as { pages: PageResponse[] }).pages).toEqual([]);
  expect((await manifest(other)).databases).toEqual([]);
  expect((await (await client.request('GET', `/api/rows/${rowId}`)).json() as DatabaseRow).title).toBe('列');
});

it('describes databases and discussions in the manifest so a device downloads only what changed', async () => {
  const stamp = async () => (await manifest()).databases.find(item => item.id === databaseId)?.stamp;
  const initial = await stamp();
  const rowId = uuid(), propertyId = uuid();
  await ok({ type: 'row.create', databaseId, rowId, title: '列', values: {} });
  const withRow = await stamp();
  expect(withRow).not.toBe(initial);
  await ok({ type: 'property.add', databaseId, propertyId, baseVersion: (await meta()).version, input: { name: '文字', type: 'text', choices: [] } });
  const withProperty = await stamp();
  expect(withProperty).not.toBe(withRow);
  await ok({ type: 'row.update', databaseId, rowId, values: { [propertyId]: { base: null, value: '值' } } });
  const withValue = await stamp();
  expect(withValue).not.toBe(withProperty);
  const page = await (await client.request('GET', `/api/pages/${rowId}`)).json() as PageResponse;
  const content = [{ id: uuid(), type: 'paragraph', props: {}, content: [{ type: 'text', text: '列內文', styles: {} }], children: [] }];
  // Row content goes through the same endpoint as notes; a row's name is not part of it.
  const synced = await client.request('PUT', `/api/offline/pages/${rowId}`, { headers: { 'if-match': `"${page.page.version}"` },
    json: { operationId: uuid(), baseVersion: page.page.version, baseTitle: '過期的名稱', title: '不應改名', content, parentId: databaseId, overwrite: false } });
  expect(synced.status).toBe(200);
  expect((await synced.json() as PageResponse).page).toMatchObject({ title: '列', content, version: page.page.version + 1 });
  expect(await stamp()).not.toBe(withValue);

  const snapshot = await (await client.request('GET', `/api/offline/databases/${databaseId}`)).json() as DatabaseSnapshotDto;
  expect(snapshot.stamp).toBe(await stamp());
  expect(snapshot.meta.properties.map(property => property.id)).toEqual([propertyId]);
  expect(snapshot.rows).toMatchObject([{ id: rowId, title: '列', values: { [propertyId]: '值' } }]);
  expect(snapshot.pages).toHaveLength(1);
  expect(snapshot.pages[0]).not.toHaveProperty('page.content');
  const batch = await (await client.request('GET', `/api/offline/pages?ids=${rowId},${uuid()},${databaseId}`)).json() as { pages: PageResponse[] };
  expect(batch.pages).toHaveLength(1);
  expect(batch.pages[0]!.page.content).toEqual(content);
  // The summary a device compares against is exactly the summary of the page it downloads.
  const { content: _content, ...summary } = batch.pages[0]!.page;
  expect(snapshot.pages[0]).toEqual({ page: summary, breadcrumbs: batch.pages[0]!.breadcrumbs });
  expect((await client.request('GET', '/api/offline/pages?ids=not-a-uuid')).status).toBe(400);

  expect((await manifest()).annotations).toEqual([]);
  const annotationId = uuid();
  await ok({ type: 'annotation.create', pageId: rowId, annotationId, messageId: uuid(), quote: '字', blockIds: ['b'], emoji: '👍', at: t.clock.now });
  const first = (await manifest()).annotations;
  expect(first).toMatchObject([{ pageId: rowId }]);
  await ok({ type: 'annotation.resolve', pageId: rowId, annotationId, resolved: true });
  expect((await manifest()).annotations[0]?.stamp).not.toBe(first[0]?.stamp);
  await client.request('DELETE', `/api/pages/${databaseId}`);
  expect(await manifest()).toMatchObject({ databases: [], annotations: [] });
});

it('stores an upload under the id the device chose and answers a repeat with the same file', async () => {
  const id = uuid();
  const upload = (who = client, fileId: string = id) => {
    const form = new FormData();
    form.append('file', new File([syntheticPng()], '離線照片.png', { type: 'image/png' }));
    form.append('id', fileId);
    return who.request('POST', '/api/files', { body: form });
  };
  const first = await upload();
  expect(first.status).toBe(201);
  const file = await first.json() as { id: string; url: string };
  expect(file).toMatchObject({ id, url: `/api/files/${id}/${encodeURIComponent('離線照片.png')}` });
  const again = await upload();
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(file);
  expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files')?.n).toBe(1);
  expect((await upload(await stranger())).status).toBe(409);
  expect((await upload(client, 'not-a-uuid')).status).toBe(400);
  // Whatever name the device used in the address, the file is found by its id.
  expect((await client.request('GET', `/api/files/${id}/anything.png`)).headers.get('content-type')).toBe('image/png');
});
