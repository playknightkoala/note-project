import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp } from '../helpers/app.ts';
import { assertSqliteCapabilities } from '../../src/server/db/driver.ts';
import { migrate, migrations } from '../../src/server/db/migrate.ts';

describe('bootstrap', () => {
  let t: TestApp;
  beforeEach(() => { t = createTestApp(); });
  afterEach(() => t.close());

  it('answers the health check and the version without authentication', async () => {
    const health = await t.app.request('/healthz');
    expect(health.status).toBe(200); expect(await health.text()).toBe('ok\n');
    const version = await t.app.request('/api/version');
    expect(version.status).toBe(200); expect(await version.json()).toEqual({ version: expect.any(String) });
  });

  it('sets the security headers on every response', async () => {
    const response = await t.app.request('/healthz');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const response = await t.app.request('/api/nothing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('applies migrations once and has FTS5 with the trigram tokenizer', () => {
    expect(migrate(t.deps.db)).toEqual([]);
    expect(t.deps.db.all<{ id: string }>('SELECT id FROM schema_migrations').map(row => row.id)).toEqual(migrations.map(m => m.id));
    expect(assertSqliteCapabilities(t.deps.db).version).toMatch(/^3\./);
    t.deps.db.run("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('u1','a@example.test','A','x','admin',1,1)");
    t.deps.db.run("INSERT INTO pages (id, user_id, title, content_text, created_at, updated_at) VALUES ('p1','u1','會議紀錄','今天討論了搜尋功能',1,1)");
    const hit = t.deps.db.get<{ title: string }>("SELECT p.title FROM page_fts f JOIN pages p ON p.rid = f.rowid WHERE page_fts MATCH ?", '搜尋功能');
    expect(hit?.title).toBe('會議紀錄');
  });
});
