import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { Annotation } from '../../src/shared/annotations.ts';

let t: TestApp; let owner: TestClient; let other: TestClient; let pageId: string; let path: string;
beforeEach(async () => {
  t = createTestApp(); owner = t.client(); other = t.client();
  await owner.register({ email: 'owner@example.test', displayName: '測試管理者', password: 'synthetic password' });
  const invite = await (await owner.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
  await other.register({ email: 'other@example.test', displayName: '測試成員', password: 'synthetic password', inviteCode: invite.code });
  pageId = ((await (await owner.request('POST', '/api/pages', { json: { title: '選取工具驗收' } })).json()) as { page: { id: string } }).page.id;
  path = `/api/pages/${pageId}/annotations`;
});
afterEach(() => t.close());
const input = { quote: '要討論的文字', blockIds: ['block-example'], text: '<script>純文字</script>' };
async function create() {
  const response = await owner.request('POST', path, { json: input });
  expect(response.status).toBe(201);
  return ((await response.json()) as { annotation: Annotation }).annotation;
}
const patch = (annotation: Annotation, json: unknown) => owner.request('PATCH', `${path}/${annotation.id}`, { json, headers: { 'If-Match': `"${annotation.version}"` } });

it('persists quoted comments, replies and emoji, toggles reactions, resolves and reopens', async () => {
  let annotation = await create();
  expect(annotation.messages[0]?.text).toBe(input.text);
  annotation = ((await (await patch(annotation, { action: 'comment', text: '回覆' })).json()) as { annotation: Annotation }).annotation;
  expect(annotation.messages).toHaveLength(2);
  annotation = ((await (await patch(annotation, { action: 'reaction', emoji: '🧑‍💻' })).json()) as { annotation: Annotation }).annotation;
  expect(annotation.reactions).toEqual(['🧑‍💻']);
  annotation = ((await (await patch(annotation, { action: 'reaction', emoji: '🧑‍💻' })).json()) as { annotation: Annotation }).annotation;
  expect(annotation.reactions).toEqual([]);
  annotation = ((await (await patch(annotation, { action: 'resolve', resolved: true })).json()) as { annotation: Annotation }).annotation;
  expect(annotation.resolved).toBe(true);
  annotation = ((await (await patch(annotation, { action: 'resolve', resolved: false })).json()) as { annotation: Annotation }).annotation;
  expect(annotation.resolved).toBe(false);
  expect(await (await owner.request('GET', path)).json()).toEqual({ annotations: [annotation] });
  // Annotations do not overwrite the independently versioned document.
  const page = await (await owner.request('GET', `/api/pages/${pageId}`)).json() as { page: { version: number } };
  expect(page.page.version).toBe(1);
});

it('requires ownership, authentication, same-origin CSRF and an active page', async () => {
  const annotation = await create();
  expect((await t.client().request('GET', path)).status).toBe(401);
  expect((await other.request('GET', path)).status).toBe(404);
  expect((await other.request('POST', path, { json: input })).status).toBe(404);
  expect((await other.request('PATCH', `${path}/${annotation.id}`, { json: { action: 'resolve', resolved: true }, headers: { 'If-Match': '"1"' } })).status).toBe(404);
  expect((await owner.request('POST', path, { json: input, csrf: false })).status).toBe(403);
  expect((await owner.request('POST', path, { json: input, origin: 'https://evil.example' })).status).toBe(403);
  await owner.request('DELETE', `/api/pages/${pageId}`);
  expect((await owner.request('GET', path)).status).toBe(404);
  expect((await patch(annotation, { action: 'comment', text: '不應寫入' })).status).toBe(404);
  await owner.request('POST', `/api/trash/${pageId}/restore`);
  expect((await owner.request('GET', path)).status).toBe(200);
  await owner.request('DELETE', `/api/pages/${pageId}`);
  await owner.request('DELETE', `/api/trash/${pageId}`);
  expect(t.deps.db.get<{ n: number }>('SELECT count(*) AS n FROM page_annotations')!.n).toBe(0);
});

it('rejects stale and missing versions without losing a concurrent reply', async () => {
  const original = await create();
  expect((await patch(original, { action: 'comment', text: '分頁 A' })).status).toBe(200);
  expect((await patch(original, { action: 'comment', text: '分頁 B' })).status).toBe(409);
  expect((await owner.request('PATCH', `${path}/${original.id}`, { json: { action: 'resolve', resolved: true } })).status).toBe(428);
  const saved = await (await owner.request('GET', path)).json() as { annotations: Annotation[] };
  expect(saved.annotations[0]?.messages.map(message => message.text)).toEqual([input.text, '分頁 A']);
});

it('validates text, anchor and emoji input and supports a reaction without a comment', async () => {
  for (const json of [{ ...input, quote: '' }, { ...input, blockIds: [] }, { ...input, text: ' ' }, { ...input, text: 'x'.repeat(4001) }, { ...input, emoji: 'javascript:alert(1)' }, { quote: '文字', blockIds: ['b'] }]) {
    expect((await owner.request('POST', path, { json })).status).toBe(400);
  }
  const response = await owner.request('POST', path, { json: { quote: '反應文字', blockIds: ['b'], emoji: '👍' } });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ annotation: { messages: [], reactions: ['👍'] } });
});

it('duplicates text formatting without carrying source discussion anchors', async () => {
  const annotation = await create();
  const content = [{ id: 'b', type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text: '討論文字', styles: { bold: true, annotation: annotation.id } }] }];
  expect((await owner.request('PUT', `/api/pages/${pageId}/content`, { json: { content }, headers: { 'If-Match': '"1"' } })).status).toBe(200);
  const response = await owner.request('POST', `/api/pages/${pageId}/duplicate`);
  expect(response.status).toBe(201);
  const copy = await response.json() as { page: { id: string; content: unknown[] } };
  expect(copy.page.content).toMatchObject([{ content: [{ text: '討論文字', styles: { bold: true } }] }]);
  expect(JSON.stringify(copy.page.content)).not.toContain(annotation.id);
  expect(await (await owner.request('GET', `/api/pages/${copy.page.id}/annotations`)).json()).toEqual({ annotations: [] });
});
