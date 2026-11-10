import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PageResponse, SearchResponse } from '../../src/shared/api.ts';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import { openDatabase } from '../../src/server/db/driver.ts';
import { migrate, migrations } from '../../src/server/db/migrate.ts';

describe('search', () => {
  let t: TestApp; let c: TestClient;
  beforeEach(async () => {
    t = createTestApp(); c = t.client();
    await c.register({ email: `${crypto.randomUUID()}@example.test`, displayName: '搜尋測試', password: crypto.randomUUID() });
  });
  afterEach(() => t.close());
  const find = async (q: string, extra = '') => {
    const res = await c.request('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`);
    expect(res.status).toBe(200);
    return await res.json() as SearchResponse;
  };
  const page = async (title: string, text = '', parentId?: string) => {
    const response = await c.request('POST', '/api/pages', { json: { title, parentId } });
    const { page } = await response.json() as PageResponse;
    if (text) {
      const saved = await c.request('PUT', `/api/pages/${page.id}/content`, { headers: { 'if-match': '"1"' }, json: {
        content: [{ id: crypto.randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }],
      } });
      expect(saved.status).toBe(200);
    }
    return page;
  };

  it('finds Chinese and English substrings in titles and contents with breadcrumbs and contextual plain text', async () => {
    const parent = await page('研究資料');
    const note = await page('週會紀錄', '開場'.repeat(120) + '台北開發者討論 BlockNote editor 搜尋功能', parent.id);
    expect((await find('開發者')).results).toEqual([expect.objectContaining({ id: note.id, snippet: expect.stringContaining('台北開發者'), breadcrumbs: [expect.objectContaining({ title: '研究資料' }), expect.objectContaining({ title: '週會紀錄' })] })]);
    expect((await find('blocknote')).results.map(r => r.id)).toEqual([note.id]);
    expect((await find('週會')).results.map(r => r.id)).toEqual([note.id]);
    expect((await find('北')).results.map(r => r.id)).toEqual([note.id]);
    expect((await find('')).total).toBe(0);
    expect((await find('   ')).results).toEqual([]);
  });

  it('treats SQL wildcards, quotes and FTS operators as literal text and never returns HTML markup', async () => {
    const special = await page('100%_完成', '<script>alert(1)</script> OR "quoted"');
    await page('普通完成', 'unrelated');
    for (const q of ['%', '_', '%_', '"quoted"', 'OR "', '<script>']) {
      expect((await find(q)).results.map(r => r.id)).toEqual([special.id]);
    }
    expect((await find('<script>')).results[0]?.snippet).toContain('<script>');
    expect((await find('" OR * --')).results).toEqual([]);
  });

  it('requires authentication and excludes other users and trash, then reflects edits, restore and deletion', async () => {
    expect((await t.client().request('GET', '/api/search?q=搜尋測試')).status).toBe(401);
    const mine = await page('搜尋測試筆記');
    const { code } = await (await c.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
    const other = t.client();
    await other.register({ email: `${crypto.randomUUID()}@example.test`, displayName: '其他帳號', password: crypto.randomUUID(), inviteCode: code });
    const foreign = await other.request('POST', '/api/pages', { json: { title: '搜尋測試私有' } });
    expect(foreign.status).toBe(201);
    expect((await find('搜尋測試')).results.map(r => r.id)).toEqual([mine.id]);
    await c.request('PATCH', `/api/pages/${mine.id}`, { json: { title: '已改名標題' } });
    expect((await find('搜尋測試')).results).toEqual([]);
    expect((await find('已改名')).total).toBe(1);
    await c.request('DELETE', `/api/pages/${mine.id}`);
    expect((await find('已改名')).total).toBe(0);
    await c.request('POST', `/api/trash/${mine.id}/restore`);
    expect((await find('已改名')).total).toBe(1);
    await c.request('DELETE', `/api/pages/${mine.id}`);
    await c.request('DELETE', `/api/trash/${mine.id}`);
    expect((await find('已改名')).results).toEqual([]);
  });

  it('orders title hits first and paginates with bounded parameters', async () => {
    const title = await page('blocknote 標題');
    await page('內文', 'blocknote');
    const first = await find('blocknote', '&limit=1');
    const next = await find('blocknote', '&limit=1&offset=1');
    expect(first).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(first.results[0]?.id).toBe(title.id);
    expect(next.results).toHaveLength(1);
    expect(next.results[0]?.id).not.toBe(title.id);
    for (const suffix of ['&limit=0', '&limit=51', '&offset=-1', '&offset=1.2', '&limit=oops', '&offset=10001']) {
      expect((await c.request('GET', '/api/search?q=x' + suffix)).status).toBe(400);
    }
    expect((await c.request('GET', '/api/search?q=' + 'x'.repeat(201))).status).toBe(400);
  });
});

it('migrates an existing index without losing notes and rebuilds external content only once', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db, migrations.slice(0, 2));
    db.run("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('u', 'migration@example.test', '遷移測試', 'synthetic', 'admin', 1, 1)");
    db.run("INSERT INTO pages (id,user_id,title,content_text,created_at,updated_at) VALUES ('p','u','既有筆記','完整搜尋功能',1,1)");
    expect(migrate(db)).toEqual(['0003_search_content', '0004_database_versions', '0005_annotations', '0006_database_views', '0007_offline_operations', '0008_offline_receipts', '0009_shares']);
    expect(db.get<{ content_text: string }>('SELECT content_text FROM page_fts WHERE page_fts MATCH ?', '搜尋功能')?.content_text).toBe('完整搜尋功能');
    expect(migrate(db)).toEqual([]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages')?.n).toBe(1);
  } finally { db.close(); }
});
