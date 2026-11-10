import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.ts';
import { sweepSessions } from '../../src/server/auth/session.ts';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import type { DatabaseDto, DatabaseRow } from '../../src/shared/database.ts';
import type { PageResponse } from '../../src/shared/api.ts';

const admin = { email: 'admin@example.test', displayName: '管理者', password: 'correct horse battery' };
const member = { email: 'member@example.test', displayName: '成員', password: 'another strong one' };
const json = { 'content-type': 'application/json', origin: 'http://localhost' };

/** A body with no Content-Length, as a chunked request arrives. */
function stream(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const size = Math.min(64 * 1024, bytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97)); sent += size;
    },
  });
}

describe('request size limits', () => {
  let t: TestApp;
  beforeEach(() => { t = createTestApp({ MAX_UPLOAD_MB: '1' }); });
  afterEach(() => t.close());

  it('refuses oversized bodies on auth endpoints, declared or streamed, before parsing them', async () => {
    const declared = await t.app.request('http://localhost/api/auth/login', { method: 'POST', headers: { ...json, 'content-length': String(10 * 1024 * 1024) }, body: '{}' });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ error: { code: 'payload_too_large' } });
    const streamed = await t.app.request('http://localhost/api/auth/login', { method: 'POST', headers: json, body: stream(1024 * 1024), duplex: 'half' } as RequestInit);
    expect(streamed.status).toBe(413);
    const register = await t.app.request('http://localhost/api/auth/register', { method: 'POST', headers: json, body: stream(1024 * 1024), duplex: 'half' } as RequestInit);
    expect(register.status).toBe(413);
  });

  it('caps JSON bodies on data endpoints and still accepts normal ones', async () => {
    const c = t.client(); await c.register(admin);
    expect((await c.request('POST', '/api/pages', { json: { title: 'x'.repeat(400) } })).status).toBe(201);
    expect((await c.request('POST', '/api/pages', { headers: { 'content-type': 'application/json' }, body: stream(9 * 1024 * 1024) })).status).toBe(413);
  });

  it('cuts off an upload sent without Content-Length once it passes the limit, and only after authentication', async () => {
    const c = t.client(); await c.register(admin);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2 * 1024 * 1024).fill(1)], { type: 'application/octet-stream' }), 'big.bin');
    const refused = await c.request('POST', '/api/files', { body: form });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: 'payload_too_large', message: '檔案超過 1 MB。' } });
    const small = new FormData();
    small.append('file', new Blob([new TextEncoder().encode('hello')], { type: 'text/plain' }), 'ok.txt');
    expect((await c.request('POST', '/api/files', { body: small })).status).toBe(201);
    expect((await t.client().request('POST', '/api/files', { body: form })).status).toBe(401);
  });
});

describe('login and registration hardening', () => {
  let t: TestApp;
  beforeEach(async () => { t = createTestApp({ TRUST_PROXY: '1' }); await t.client().register(admin); });
  afterEach(() => t.close());
  const attempt = (identifier: string, password: string, headers: Record<string, string>) =>
    t.client().request('POST', '/api/auth/login', { json: { identifier, password }, headers });

  it('keys the address limit on the last X-Forwarded-For hop, so a spoofed first hop changes nothing', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await attempt(`nobody${i}@example.test`, 'wrong password', { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` })).status);
    expect(codes.slice(0, 10).every(code => code === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // A different real address is unaffected.
    expect((await attempt('nobody@example.test', 'wrong password', { 'x-forwarded-for': '198.51.100.8' })).status).toBe(401);
  });

  it('prefers the configured client address header over X-Forwarded-For', async () => {
    const cf = createTestApp({ TRUST_PROXY: '1', CLIENT_IP_HEADER: 'CF-Connecting-IP' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await cf.client().request('POST', '/api/auth/login', { json: { identifier: `n${i}@example.test`, password: 'wrong password' }, headers: { 'cf-connecting-ip': '192.0.2.9', 'x-forwarded-for': `203.0.113.${i}` } })).status);
      expect(codes.at(-1)).toBe(429);
    } finally { cf.close(); }
  });

  it('does not let failed guesses from one address lock the owner out from another', async () => {
    for (let i = 0; i < 5; i++) expect((await attempt(admin.email, 'wrong password', { 'x-forwarded-for': '203.0.113.50' })).status).toBe(401);
    const sameAddress = await attempt(admin.email, admin.password, { 'x-forwarded-for': '203.0.113.50' });
    expect(sameAddress.status).toBe(429); expect(sameAddress.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await attempt(admin.email, admin.password, { 'x-forwarded-for': '198.51.100.20' })).status).toBe(200);
  });

  it('still stops guessing spread over many addresses with the per-account backstop', async () => {
    for (let i = 0; i < 30; i++) expect((await attempt(admin.email, 'wrong password', { 'x-forwarded-for': `203.0.113.${i}` })).status).toBe(401);
    expect((await attempt(admin.email, 'wrong password', { 'x-forwarded-for': '203.0.113.200' })).status).toBe(429);
    t.clock.now += 16 * 60 * 1000;
    expect((await attempt(admin.email, admin.password, { 'x-forwarded-for': '203.0.113.200' })).status).toBe(200);
  });

  it('refuses cross-site and form-encoded sign-in so a page cannot log the visitor into another account', async () => {
    const body = { identifier: admin.email, password: admin.password };
    const crossSite = await t.client().request('POST', '/api/auth/login', { json: body, origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403); expect(crossSite.headers.get('set-cookie')).toBeNull();
    expect((await t.client().request('POST', '/api/auth/login', { json: body, origin: 'null' })).status).toBe(403);
    const form = await t.client().request('POST', '/api/auth/login', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(form.status).toBe(415); expect(form.headers.get('set-cookie')).toBeNull();
    expect((await t.client().request('POST', '/api/auth/register', { json: { ...member, inviteCode: 'x' }, origin: 'https://evil.example' })).status).toBe(403);
    // Non-browser clients send no Origin at all.
    expect((await t.client().request('POST', '/api/auth/login', { json: body, origin: null })).status).toBe(200);
  });

  it('answers the same for known and unknown emails when the invite is not valid', async () => {
    const known = await t.client().request('POST', '/api/auth/register', { json: { ...member, email: admin.email, inviteCode: 'bogus' }, headers: { 'x-forwarded-for': '192.0.2.1' } });
    const unknown = await t.client().request('POST', '/api/auth/register', { json: { ...member, inviteCode: 'bogus' }, headers: { 'x-forwarded-for': '192.0.2.1' } });
    expect(known.status).toBe(400); expect(unknown.status).toBe(400);
    expect(await known.json()).toEqual(await unknown.json());
  });
});

describe('first-account setup token', () => {
  it('requires the configured token to create the administrator and reports that it is needed', async () => {
    const token = `setup-${crypto.randomUUID()}`;
    const t = createTestApp({ SETUP_TOKEN: token });
    try {
      expect(await (await t.app.request('/api/auth/status')).json()).toEqual({ setupRequired: true, setupTokenRequired: true });
      expect((await t.client().register(admin)).status).toBe(400);
      expect((await t.client().register({ ...admin, inviteCode: 'wrong-token-value' })).status).toBe(400);
      const created = await t.client().register({ ...admin, inviteCode: token });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ user: { role: 'admin' } });
      expect(await (await t.app.request('/api/auth/status')).json()).toEqual({ setupRequired: false });
      // The token is not an invite: later accounts still need a real one.
      expect((await t.client().register({ ...member, inviteCode: token })).status).toBe(400);
    } finally { t.close(); }
  });
});

describe('session sweep', () => {
  it('removes idle-expired and absolute-expired sessions and keeps live ones', async () => {
    const t = createTestApp();
    try {
      const old = t.client(); await old.register(admin);
      t.clock.now += 31 * 24 * 60 * 60 * 1000;
      const live = t.client(); await live.login(admin.email, admin.password);
      expect(sweepSessions(t.deps.db, t.clock.now)).toBe(1);
      expect((await live.request('GET', '/api/auth/me')).status).toBe(200);
      expect((await old.request('GET', '/api/auth/me')).status).toBe(401);
    } finally { t.close(); }
  });
});

describe('static files', () => {
  it('answers 404 for a missing hashed asset instead of the app shell', async () => {
    const t = createTestApp();
    const clientDir = mkdtempSync(join(tmpdir(), 'notes-client-'));
    try {
      mkdirSync(join(clientDir, 'assets'));
      writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>shell</title>');
      writeFileSync(join(clientDir, 'assets', 'app.js'), 'export {};');
      const app = createApp({ ...t.deps, clientDir });
      expect((await app.request('/assets/app.js')).status).toBe(200);
      const missing = await app.request('/assets/gone-123.js');
      expect(missing.status).toBe(404); expect(await missing.text()).not.toContain('shell');
      const route = await app.request('/some/page');
      expect(route.status).toBe(200); expect(await route.text()).toContain('shell');
    } finally { rmSync(clientDir, { recursive: true, force: true }); t.close(); }
  });
});

describe('database edge cases', () => {
  let t: TestApp; let c: TestClient; let meta: DatabaseDto;
  beforeEach(async () => {
    t = createTestApp(); c = t.client(); await c.register(admin);
    const { page } = await (await c.request('POST', '/api/pages', { json: { kind: 'database', title: '任務' } })).json() as PageResponse;
    meta = await (await c.request('GET', `/api/databases/${page.id}`)).json() as DatabaseDto;
  });
  afterEach(() => t.close());
  const match = (version: number) => ({ 'if-match': `"${version}"` });

  it('keeps sorts and still-valid filters when choices are added or renamed, and drops filters on removed choices', async () => {
    const todo = { id: crypto.randomUUID(), label: '待辦', color: 'gray' }, done = { id: crypto.randomUUID(), label: '完成', color: 'green' };
    meta = await (await c.request('POST', `/api/databases/${meta.id}/properties`, { headers: match(meta.version), json: { name: '狀態', type: 'select', choices: [todo, done] } })).json() as DatabaseDto;
    const prop = meta.properties[0]!, url = `/api/databases/${meta.id}/properties/${prop.id}`;
    const config = { sorts: [{ propertyId: prop.id, direction: 'asc' }], filters: [
      { propertyId: prop.id, operator: 'equals', value: todo.id }, { propertyId: prop.id, operator: 'not_equals', value: done.id }, { propertyId: prop.id, operator: 'is_not_empty', value: null }] };
    meta = await (await c.request('PATCH', `/api/databases/${meta.id}/views/${meta.views[0]!.id}`, { headers: match(meta.version), json: { name: '表格', config } })).json() as DatabaseDto;

    const added = await c.request('PATCH', url, { headers: match(meta.version), json: { choices: [{ ...todo, label: '尚未開始' }, done, { id: crypto.randomUUID(), label: '封存', color: 'red' }] } });
    expect(added.status).toBe(200); meta = await added.json() as DatabaseDto;
    expect(meta.views[0]!.config).toMatchObject(config);

    const removed = await c.request('PATCH', url, { headers: match(meta.version), json: { choices: [{ ...todo, label: '尚未開始' }] } });
    expect(removed.status).toBe(200); meta = await removed.json() as DatabaseDto;
    expect(meta.views[0]!.config.sorts).toEqual(config.sorts);
    expect(meta.views[0]!.config.filters).toEqual([config.filters[0], config.filters[2]]);
  });

  it('refuses to restore a row while its database is still in the trash', async () => {
    const row = await (await c.request('POST', `/api/databases/${meta.id}/rows`, { headers: match(meta.version), json: { title: '列' } })).json() as DatabaseRow;
    expect((await c.request('DELETE', `/api/pages/${row.id}`)).status).toBe(200);
    expect((await c.request('DELETE', `/api/pages/${meta.id}`)).status).toBe(200);
    expect((await c.request('POST', `/api/trash/${row.id}/restore`)).status).toBe(409);
    expect((await c.request('POST', `/api/trash/${meta.id}/restore`)).status).toBe(200);
    expect((await c.request('POST', `/api/trash/${row.id}/restore`)).status).toBe(200);
    const listed = await (await c.request('GET', `/api/databases/${meta.id}/rows`)).json() as { rows: DatabaseRow[] };
    expect(listed.rows.map(item => item.id)).toEqual([row.id]);
  });
});
