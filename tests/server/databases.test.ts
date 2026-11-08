import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { DatabaseDto, DatabaseRow, RowsDto, PropertyType } from '../../src/shared/database.ts';
import type { PageResponse } from '../../src/shared/api.ts';

describe('database API', () => {
  let t: TestApp; let c: TestClient; let meta: DatabaseDto;
  beforeEach(async () => {
    t = createTestApp(); c = t.client();
    await c.register({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID(), displayName: '資料庫測試' });
    const created = await c.request('POST', '/api/pages', { json: { kind: 'database', title: '任務' } });
    const { page } = await created.json() as PageResponse;
    meta = await (await c.request('GET', `/api/databases/${page.id}`)).json() as DatabaseDto;
  });
  afterEach(() => t.close());
  const match = (version: number) => ({ 'if-match': `"${version}"` });
  async function property(type: PropertyType, choices: { id: string; label: string; color: string }[] = []) {
    const res = await c.request('POST', `/api/databases/${meta.id}/properties`, { headers: match(meta.version), json: { name: type, type, choices } });
    expect(res.status).toBe(201);
    meta = await res.json() as DatabaseDto;
    return meta.properties.at(-1)!;
  }
  async function row(title: string, values = {}) {
    const res = await c.request('POST', `/api/databases/${meta.id}/rows`, { headers: match(meta.version), json: { title, values } });
    expect(res.status).toBe(201);
    return await res.json() as DatabaseRow;
  }
  async function rows(sort: unknown[] = [], filter: unknown[] = [], extra = '') {
    const query = new URLSearchParams({ sort: JSON.stringify(sort), filter: JSON.stringify(filter) });
    const response = await c.request('GET', `/api/databases/${meta.id}/rows?${query}${extra}`);
    expect(response.status).toBe(200);
    return await response.json() as RowsDto;
  }

  it('creates a default view and supports all seven property value types with independent versions', async () => {
    expect(meta).toMatchObject({ version: 1, properties: [], views: [expect.objectContaining({ name: '表格', config: { sorts: [], filters: [] } })] });
    const choice = { id: crypto.randomUUID(), label: '進行中', color: 'blue' };
    const values: Record<string, unknown> = {};
    const examples: Record<PropertyType, unknown> = { text: '摘要', number: 0, select: choice.id, multi_select: [choice.id], date: '2028-02-29', checkbox: false, url: 'https://example.test/task' };
    for (const [type, value] of Object.entries(examples)) {
      const prop = await property(type as PropertyType, ['select', 'multi_select'].includes(type) ? [choice] : []);
      values[prop.id] = value;
    }
    const task = await row('一個任務', values);
    expect(task).toMatchObject({ title: '一個任務', version: 1, values });
    expect((await rows()).rows[0]).toEqual(task);
    const page = await (await c.request('GET', `/api/pages/${task.id}`)).json() as PageResponse;
    expect(page).toMatchObject({ page: { kind: 'row', parentId: meta.id, databaseId: meta.id, version: 1 }, breadcrumbs: [expect.objectContaining({ title: '任務' }), expect.objectContaining({ title: '一個任務' })] });
    expect((await (await c.request('GET', '/api/pages/tree')).json() as { pages: { id: string }[] }).pages.some(p => p.id === task.id)).toBe(false);
    const updated = await c.request('PATCH', `/api/rows/${task.id}/values`, { headers: match(1), json: { title: '改名', values: { [meta.properties[0]!.id]: null } } });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ title: '改名', version: 2 });
    const after = await (await c.request('GET', `/api/pages/${task.id}`)).json() as PageResponse;
    expect(after.page.version).toBe(1);
    const content = await c.request('PUT', `/api/pages/${task.id}/content`, { headers: match(1), json: { content: [{ id: crypto.randomUUID(), type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text: '列內文', styles: {} }] }] } });
    expect(content.status).toBe(200);
    expect((await (await c.request('GET', `/api/rows/${task.id}`)).json() as DatabaseRow).version).toBe(2);
  });

  it('requires If-Match for schema and row writes, rejects stale clients and rolls back complete writes', async () => {
    const prop = await property('number');
    const task = await row('原標題', { [prop.id]: 10 });
    expect((await c.request('POST', `/api/databases/${meta.id}/properties`, { json: { name: 'no', type: 'text' } })).status).toBe(428);
    expect((await c.request('POST', `/api/databases/${meta.id}/rows`, { headers: match(1), json: {} })).status).toBe(409);
    expect((await c.request('PATCH', `/api/rows/${task.id}/values`, { headers: match(0), json: { title: '不應覆蓋' } })).status).toBe(409);
    expect((await c.request('PATCH', `/api/rows/${task.id}/values`, { headers: match(1), json: { title: '不應覆蓋', values: { [prop.id]: 11, [crypto.randomUUID()]: 'x' } } })).status).toBe(404);
    expect(await (await c.request('GET', `/api/rows/${task.id}`)).json()).toMatchObject({ title: '原標題', version: 1, values: { [prop.id]: 10 } });
    await c.request('PATCH', `/api/pages/${task.id}`, { json: { title: '整頁改名' } });
    expect((await c.request('PATCH', `/api/rows/${task.id}/values`, { headers: match(1), json: { values: { [prop.id]: 12 } } })).status).toBe(409);
  });

  it.each([
    ['number', '12'], ['date', '2027-02-29'], ['date', '2026-13-01'], ['checkbox', 'true'],
    ['url', 'javascript:alert(1)'], ['select', 'not-an-option'], ['multi_select', ['unknown']],
  ] as [PropertyType, unknown][])('rejects invalid %s cells', async (type, value) => {
    const prop = await property(type);
    const response = await c.request('POST', `/api/databases/${meta.id}/rows`, { headers: match(meta.version), json: { values: { [prop.id]: value } } });
    expect(response.status).toBe(400);
    expect((await rows()).total).toBe(0);
  });

  it('persists views, evaluates typed sorting and AND filters, and paginates stably', async () => {
    const score = await property('number');
    const done = await property('checkbox');
    await row('低', { [score.id]: 2 }); await row('高', { [score.id]: 100 }); await row('缺值');
    await row('完成', { [score.id]: 20, [done.id]: true });
    const sorts = [{ propertyId: score.id, direction: 'desc' }];
    const filters = [{ propertyId: score.id, operator: 'gte', value: 2 }, { propertyId: done.id, operator: 'equals', value: false }];
    const view = await c.request('PATCH', `/api/databases/${meta.id}/views/${meta.views[0]!.id}`, { headers: match(meta.version), json: { name: '待辦', config: { sorts, filters, columns: [score.id] } } });
    expect(view.status).toBe(200);
    expect((await view.json() as DatabaseDto).views[0]).toMatchObject({ name: '待辦', config: { sorts, filters, columns: [score.id] } });
    const first = await rows(sorts, filters, '&limit=1');
    expect(first).toMatchObject({ total: 2, rows: [expect.objectContaining({ title: '高' })] });
    expect((await rows(sorts, filters, '&limit=1&offset=1')).rows[0]?.title).toBe('低');
    expect((await rows(sorts)).rows.at(-1)?.title).toBe('缺值');
    for (const query of ['filter=nope', 'limit=201', 'offset=-1', 'sort=' + encodeURIComponent(JSON.stringify([{ propertyId: crypto.randomUUID(), direction: 'asc' }]))]) expect((await c.request('GET', `/api/databases/${meta.id}/rows?${query}`)).status).toBe(400);
    expect((await c.request('GET', `/api/databases/${meta.id}/rows?filter=${encodeURIComponent(JSON.stringify([{ propertyId: score.id, operator: 'contains', value: '2' }]))}`)).status).toBe(400);
  });

  it('protects populated types and used choices, and prunes deleted columns from saved views', async () => {
    const choice = { id: crypto.randomUUID(), label: '待辦', color: 'green' };
    const prop = await property('select', [choice]);
    const task = await row('任務', { [prop.id]: choice.id });
    const url = `/api/databases/${meta.id}/properties/${prop.id}`;
    expect((await c.request('PATCH', url, { headers: match(meta.version), json: { type: 'number', choices: [] } })).status).toBe(409);
    expect((await c.request('PATCH', url, { headers: match(meta.version), json: { choices: [] } })).status).toBe(409);
    const saved = await c.request('PATCH', `/api/databases/${meta.id}/views/${meta.views[0]!.id}`, { headers: match(meta.version), json: { name: '表格', config: { sorts: [{ propertyId: prop.id, direction: 'asc' }], filters: [{ propertyId: prop.id, operator: 'equals', value: choice.id }], columns: [prop.id] } } });
    meta = await saved.json() as DatabaseDto;
    const deleted = await c.request('DELETE', url, { headers: match(meta.version) });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ properties: [], views: [expect.objectContaining({ config: { sorts: [], filters: [], columns: [] } })] });
    expect(await (await c.request('GET', `/api/rows/${task.id}`)).json()).toMatchObject({ values: {} });
  });

  it('isolates databases, properties, views and rows across users and enforces CSRF', async () => {
    const prop = await property('text'); const task = await row('私有');
    const invite = await c.request('POST', '/api/admin/invites', { json: {} });
    const { code } = await invite.json() as { code: string };
    const other = t.client(); await other.register({ email: `${crypto.randomUUID()}@example.test`, password: crypto.randomUUID(), displayName: '另一位', inviteCode: code });
    for (const path of [`/api/databases/${meta.id}`, `/api/databases/${meta.id}/rows`, `/api/rows/${task.id}`]) {
      expect((await other.request('GET', path)).status).toBe(404);
      expect((await t.client().request('GET', path)).status).toBe(401);
    }
    for (const [method, path, json] of [
      ['POST', `/api/databases/${meta.id}/properties`, { name: 'x', type: 'text' }],
      ['PATCH', `/api/databases/${meta.id}/properties/${prop.id}`, { name: 'x' }],
      ['DELETE', `/api/databases/${meta.id}/properties/${prop.id}`, undefined],
      ['PATCH', `/api/databases/${meta.id}/views/${meta.views[0]!.id}`, { name: 'x', config: {} }],
      ['POST', `/api/databases/${meta.id}/rows`, {}], ['PATCH', `/api/rows/${task.id}/values`, { values: {} }],
    ] as const) {
      const options = { headers: match(1), ...(json ? { json } : {}) };
      expect((await other.request(method, path, options)).status).toBe(404);
      expect((await c.request(method, path, { ...options, csrf: false })).status).toBe(403);
      expect((await c.request(method, path, { ...options, origin: 'https://foreign.example' })).status).toBe(403);
    }
  });

  it('trashes and restores rows with their values, and cascades deletion through a database', async () => {
    const prop = await property('text'); const task = await row('刪除測試', { [prop.id]: '保留內容' });
    await c.request('DELETE', `/api/pages/${task.id}`);
    expect((await rows()).total).toBe(0);
    expect((await c.request('GET', `/api/rows/${task.id}`)).status).toBe(404);
    await c.request('POST', `/api/trash/${task.id}/restore`);
    expect((await rows()).rows[0]?.values[prop.id]).toBe('保留內容');
    await c.request('DELETE', `/api/pages/${meta.id}`);
    expect((await c.request('GET', `/api/databases/${meta.id}`)).status).toBe(404);
    await c.request('POST', `/api/trash/${meta.id}/restore`);
    expect((await rows()).total).toBe(1);
    await c.request('DELETE', `/api/pages/${meta.id}`);
    await c.request('DELETE', `/api/trash/${meta.id}`);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM row_values')?.n).toBe(0);
    expect((await c.request('GET', `/api/rows/${task.id}`)).status).toBe(404);
  });

  it('caps a database at 5000 rows, including trash, without affecting the schema version', async () => {
    const seed = await row('種子');
    t.deps.db.transaction(() => {
      const owner = t.deps.db.get<{ user_id: string }>('SELECT user_id FROM pages WHERE id = ?', meta.id)!.user_id;
      for (let i = 1; i < 5000; i++) t.deps.db.run("INSERT INTO pages (id,user_id,parent_id,database_id,kind,position,title,created_at,updated_at) VALUES (?,?,?,?,'row',?,'',1,1)", crypto.randomUUID(), owner, meta.id, meta.id, i + 1024);
    });
    await c.request('DELETE', `/api/pages/${seed.id}`);
    expect((await c.request('POST', `/api/databases/${meta.id}/rows`, { headers: match(meta.version), json: {} })).status).toBe(409);
    expect((await rows([], [], '&offset=4998&limit=2')).rows).toHaveLength(1);
    expect((await (await c.request('GET', `/api/databases/${meta.id}`)).json() as DatabaseDto).version).toBe(meta.version);
  });
});
