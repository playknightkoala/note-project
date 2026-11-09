import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { PageResponse } from '../../src/shared/api.ts';
import type { SyncNoteInput } from '../../src/shared/offline.ts';

let t: TestApp, client: TestClient;
const block = (text: string) => [{ id: crypto.randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }];
const operation = (changes: Partial<SyncNoteInput> = {}): SyncNoteInput => ({ operationId: crypto.randomUUID(), baseVersion: null, baseTitle: '', title: '離線筆記', content: block('手機記錄'), parentId: null, overwrite: false, ...changes });
const save = (id: string, input: SyncNoteInput, who = client) => who.request('PUT', `/api/offline/pages/${id}`, { json: input, headers: { 'if-match': `"${input.baseVersion ?? 0}"` } });
beforeEach(async () => {
  t = createTestApp(); client = t.client();
  await client.register({ email: `${crypto.randomUUID()}@example.test`, displayName: '合成測試', password: crypto.randomUUID() });
});
afterEach(() => t.close());

it('creates once and returns the original receipt when a lost response is retried', async () => {
  const id = crypto.randomUUID(), input = operation();
  const first = await save(id, input);
  expect(first.status).toBe(200);
  const response = await first.json() as PageResponse;
  expect(response.page).toMatchObject({ id, title: input.title, content: input.content });
  expect(await (await save(id, input)).json()).toEqual(response);
  expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages')?.n).toBe(1);
  expect((await save(id, operation())).status).toBe(404);
});

it('rejects outdated content and title baselines; explicit overwrite saves the outgoing history', async () => {
  const id = crypto.randomUUID();
  const initial = await (await save(id, operation())).json() as PageResponse;
  const input = operation({ baseVersion: initial.page.version, baseTitle: initial.page.title, title: '手機的新標題' });
  await client.request('PATCH', `/api/pages/${id}`, { json: { title: '電腦的新標題' } });
  expect((await save(id, input)).status).toBe(409);
  const overwritten = await (await save(id, { ...input, overwrite: true })).json() as PageResponse;
  expect(overwritten.page.title).toBe(input.title);
  const versions = await (await client.request('GET', `/api/pages/${id}/versions`)).json() as { versions: { title: string }[] };
  expect(versions.versions.some(v => v.title === '電腦的新標題')).toBe(true);
  expect((await save(id, operation({ baseVersion: initial.page.version, baseTitle: input.title }))).status).toBe(409);
});

it('enforces authentication, CSRF, If-Match and account ownership even for receipt replay', async () => {
  const id = crypto.randomUUID(), input = operation();
  expect((await save(id, input, t.client())).status).toBe(401);
  expect((await client.request('PUT', `/api/offline/pages/${id}`, { json: input, csrf: false })).status).toBe(403);
  expect((await client.request('PUT', `/api/offline/pages/${id}`, { json: input })).status).toBe(428);
  await save(id, input);
  const invitation = await (await client.request('POST', '/api/admin/invites', { json: { expiresInHours: 24 } })).json() as { code: string };
  const other = t.client();
  await other.register({ email: `${crypto.randomUUID()}@example.test`, displayName: '另一位', password: crypto.randomUUID(), inviteCode: invitation.code });
  expect((await save(id, input, other)).status).toBe(404);
  expect((await save(id, operation({ baseVersion: 1 }), other)).status).toBe(404);
  expect((await client.request('PUT', `/api/offline/pages/${crypto.randomUUID()}`, { json: operation(), origin: 'https://evil.example', headers: { 'if-match': '"0"' } })).status).toBe(403);
});

it('rolls back invalid content and refuses database pages without partially changing their title', async () => {
  const id = crypto.randomUUID();
  expect((await save(id, operation({ content: [{ invalid: true }] }))).status).toBe(400);
  expect(t.deps.db.get('SELECT id FROM pages WHERE id = ?', id)).toBeUndefined();
  const database = await (await client.request('POST', '/api/pages', { json: { kind: 'database', title: '資料庫' } })).json() as PageResponse;
  expect((await save(database.page.id, operation({ baseVersion: database.page.version, baseTitle: database.page.title }))).status).toBe(400);
});
