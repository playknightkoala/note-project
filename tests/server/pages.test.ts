import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { PageNode, PageResponse } from '../../src/shared/api.ts';
import { extractPlainText } from '../../src/shared/text.ts';
import { parseBlocks } from '../../src/shared/blocks.ts';

const admin = { email: 'admin@example.test', displayName: '管理者', password: 'correct horse battery' };
const paragraph = (text: string, id = crypto.randomUUID()) => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });

async function createPage(c: TestClient, input: Record<string, unknown> = {}) {
  const response = await c.request('POST', '/api/pages', { json: input });
  expect(response.status).toBe(201);
  return (await response.json() as PageResponse).page;
}
async function tree(c: TestClient): Promise<PageNode[]> { return (await (await c.request('GET', '/api/pages/tree')).json() as { pages: PageNode[] }).pages; }
const ordered = (nodes: PageNode[], parentId: string | null) => nodes.filter(n => n.parentId === parentId).sort((a, b) => a.position - b.position).map(n => n.title);

describe('block helpers', () => {
  it('validates block shape, depth and size, and extracts searchable text', () => {
    expect('error' in parseBlocks([{ type: 'paragraph' }])).toBe(true);
    let deep: Record<string, unknown> = paragraph('leaf');
    for (let i = 0; i < 21; i++) deep = { ...paragraph('n'), children: [deep] };
    expect(parseBlocks([deep])).toMatchObject({ error: expect.stringContaining('巢狀') });
    const ok = parseBlocks([paragraph('你好'), { id: 'x', type: 'image', props: { url: '/api/files/1', name: '圖.png', caption: '說明' }, children: [] }]);
    expect('blocks' in ok).toBe(true);
    if ('blocks' in ok) expect(extractPlainText(ok.blocks)).toBe('你好\n圖.png說明');
    const table = { id: 't', type: 'table', props: {}, content: { type: 'tableContent', rows: [{ cells: [[{ type: 'text', text: 'a', styles: {} }], [{ type: 'text', text: 'b', styles: {} }]] }] }, children: [] };
    expect(extractPlainText([table])).toBe('a b');
  });
});

describe('pages', () => {
  let t: TestApp; let c: TestClient;
  beforeEach(async () => { t = createTestApp(); c = t.client(); await c.register(admin); });
  afterEach(() => t.close());

  it('creates, nests, orders and moves pages without cycles', async () => {
    const a = await createPage(c, { title: 'A' });
    const b = await createPage(c, { title: 'B' });
    const a1 = await createPage(c, { title: 'A1', parentId: a.id });
    const between = await createPage(c, { title: 'AB', afterId: a.id });
    expect(ordered(await tree(c), null)).toEqual(['A', 'AB', 'B']);
    expect((await tree(c)).find(n => n.id === a.id)?.hasChildren).toBe(true);
    expect((await c.request('POST', `/api/pages/${b.id}/move`, { json: { parentId: null, index: 0 } })).status).toBe(200);
    expect(ordered(await tree(c), null)).toEqual(['B', 'A', 'AB']);
    expect((await c.request('POST', `/api/pages/${a.id}/move`, { json: { parentId: a1.id, index: 0 } })).status).toBe(400);
    expect((await c.request('POST', `/api/pages/${a.id}/move`, { json: { parentId: a.id, index: 0 } })).status).toBe(400);
    expect((await c.request('POST', `/api/pages/${between.id}/move`, { json: { parentId: a.id, index: 0 } })).status).toBe(200);
    expect(ordered(await tree(c), a.id)).toEqual(['AB', 'A1']);
    const page = await (await c.request('GET', `/api/pages/${a1.id}`)).json() as PageResponse;
    expect(page.breadcrumbs.map(b => b.title)).toEqual(['A', 'A1']);
    expect(page.page.content).toHaveLength(1);
  });

  it('renormalizes positions when many pages are inserted at the same slot', async () => {
    const first = await createPage(c, { title: 'p0' });
    for (let i = 1; i <= 12; i++) await createPage(c, { title: `p${i}`, afterId: first.id });
    expect(ordered(await tree(c), null)).toEqual(['p0', 'p12', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
  });

  it('saves content with If-Match, refuses stale versions and keeps snapshots', async () => {
    const page = await createPage(c, { title: '筆記' });
    const missing = await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [paragraph('x')] } });
    expect(missing.status).toBe(428);
    const first = await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [paragraph('第一版')] }, headers: { 'if-match': `"${page.version}"` } });
    expect(first.status).toBe(200);
    const head = await first.json() as { version: number };
    expect(head.version).toBe(page.version + 1);
    const stale = await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [paragraph('舊分頁')] }, headers: { 'if-match': `"${page.version}"` } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'version_conflict', details: { current: { version: head.version } } } });
    const loaded = await (await c.request('GET', `/api/pages/${page.id}`)).json() as PageResponse;
    expect(loaded.page.content).toEqual([expect.objectContaining({ type: 'paragraph' })]);
    expect(t.deps.db.get<{ content_text: string }>('SELECT content_text FROM pages WHERE id = ?', page.id)?.content_text).toBe('第一版');
    // snapshots: first save captured the original; a save within 10 minutes does not add another; after 10 minutes it does
    t.clock.now += 1000;
    await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [paragraph('第二版')] }, headers: { 'if-match': `"${head.version}"` } });
    t.clock.now += 11 * 60 * 1000;
    const third = await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [paragraph('第三版')] }, headers: { 'if-match': `"${head.version + 1}"` } });
    expect(third.status).toBe(200);
    const versions = (await (await c.request('GET', `/api/pages/${page.id}/versions`)).json() as { versions: { id: string; version: number }[] }).versions;
    expect(versions.map(v => v.version)).toEqual([head.version + 1, page.version]);
    const restored = await c.request('POST', `/api/pages/${page.id}/versions/${versions[1]!.id}/restore`, { headers: { 'if-match': `"${head.version + 2}"` } });
    expect(restored.status).toBe(200);
    const after = await (await c.request('GET', `/api/pages/${page.id}`)).json() as PageResponse;
    expect(after.page.content).toEqual([expect.objectContaining({ type: 'paragraph', content: [] })]);
    expect((await c.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [{ type: 'bad' }] }, headers: { 'if-match': '"1"' } })).status).toBe(400);
  });

  it('patches title and icon without touching the content version, and toggles favorites', async () => {
    const page = await createPage(c, {});
    const patched = await (await c.request('PATCH', `/api/pages/${page.id}`, { json: { title: '標題', icon: '📘', fullWidth: true } })).json() as PageResponse;
    expect(patched.page).toMatchObject({ title: '標題', icon: '📘', fullWidth: true, version: page.version });
    expect((await c.request('POST', `/api/pages/${page.id}/favorite`, { json: { favorite: true } })).status).toBe(200);
    expect((await tree(c)).find(n => n.id === page.id)).toMatchObject({ isFavorite: true, title: '標題' });
    expect((await c.request('PATCH', `/api/pages/${page.id}`, { json: { coverFileId: crypto.randomUUID() } })).status).toBe(404);
  });

  it('trashes subtrees, lists trash roots, restores to a live parent or root, and deletes permanently', async () => {
    const root = await createPage(c, { title: 'root' });
    const child = await createPage(c, { title: 'child', parentId: root.id });
    const grand = await createPage(c, { title: 'grand', parentId: child.id });
    await c.request('POST', `/api/pages/${grand.id}/favorite`, { json: { favorite: true } });
    const trashed = await c.request('DELETE', `/api/pages/${child.id}`);
    expect(await trashed.json()).toEqual({ trashedCount: 2 });
    expect((await tree(c)).map(n => n.title)).toEqual(['root']);
    expect((await c.request('GET', `/api/pages/${grand.id}/head`)).status).toBe(404);
    const trash = (await (await c.request('GET', '/api/trash')).json() as { items: { id: string; descendantCount: number }[] }).items;
    expect(trash).toEqual([expect.objectContaining({ id: child.id, descendantCount: 1 })]);
    expect((await c.request('POST', `/api/trash/${grand.id}/restore`)).status).toBe(404);
    expect((await c.request('POST', `/api/trash/${child.id}/restore`)).status).toBe(200);
    expect(ordered(await tree(c), root.id)).toEqual(['child']);
    expect((await tree(c)).find(n => n.id === grand.id)).toMatchObject({ isFavorite: false, parentId: child.id });
    // parent trashed first, child restored later → child goes to root
    await c.request('DELETE', `/api/pages/${root.id}`);
    await c.request('DELETE', `/api/pages/${child.id}`); // already trashed as part of root: no-op
    expect((await (await c.request('GET', '/api/trash')).json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await c.request('DELETE', `/api/trash/${root.id}`)).status).toBe(204);
    expect((await c.request('GET', `/api/pages/${grand.id}`)).status).toBe(404);
    const again = await createPage(c, { title: 'x' });
    await c.request('DELETE', `/api/pages/${again.id}`);
    expect(await (await c.request('DELETE', '/api/trash')).json()).toEqual({ deleted: 1 });
  });

  it('duplicates a page with its subtree right after the original', async () => {
    const page = await createPage(c, { title: '原本' });
    await createPage(c, { title: '子', parentId: page.id });
    await createPage(c, { title: '之後' });
    const copy = await (await c.request('POST', `/api/pages/${page.id}/duplicate`)).json() as PageResponse;
    expect(copy.page.title).toBe('原本（副本）');
    expect(ordered(await tree(c), null)).toEqual(['原本', '原本（副本）', '之後']);
    expect(ordered(await tree(c), copy.page.id)).toEqual(['子']);
  });

  it('never exposes another user\'s pages', async () => {
    const page = await createPage(c, { title: '私人' });
    const { code } = await (await c.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
    const other = t.client();
    await other.register({ email: 'o@example.test', displayName: 'O', password: 'other strong pass', inviteCode: code });
    expect((await other.request('GET', `/api/pages/${page.id}`)).status).toBe(404);
    expect((await other.request('PUT', `/api/pages/${page.id}/content`, { json: { content: [] }, headers: { 'if-match': '"1"' } })).status).toBe(404);
    expect((await other.request('DELETE', `/api/pages/${page.id}`)).status).toBe(404);
    expect(await tree(other)).toEqual([]);
  });
});

describe('covers', () => {
  let t: TestApp; let c: TestClient;
  beforeEach(async () => { t = createTestApp(); c = t.client(); await c.register(admin); });
  afterEach(() => t.close());
  it('accepts a preset cover, swaps it for an uploaded file, and clears both', async () => {
    const page = await createPage(c, {});
    expect(((await (await c.request('PATCH', `/api/pages/${page.id}`, { json: { coverPreset: 'gradient:2' } })).json()) as PageResponse).page.coverUrl).toBe('gradient:2');
    expect((await c.request('PATCH', `/api/pages/${page.id}`, { json: { coverPreset: 'javascript:1' } })).status).toBe(400);
    const form = new FormData(); form.append('file', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: 'image/png' }), 'c.png');
    const file = await (await c.request('POST', '/api/files', { body: form })).json() as { id: string };
    const withFile = (await (await c.request('PATCH', `/api/pages/${page.id}`, { json: { coverFileId: file.id, coverPosition: 30 } })).json()) as PageResponse;
    expect(withFile.page).toMatchObject({ coverUrl: `/api/files/${file.id}`, coverPosition: 30 });
    const cleared = (await (await c.request('PATCH', `/api/pages/${page.id}`, { json: { coverFileId: null, coverPreset: null } })).json()) as PageResponse;
    expect(cleared.page.coverUrl).toBeNull();
  });
});
