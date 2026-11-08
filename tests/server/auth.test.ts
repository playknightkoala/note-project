import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp } from '../helpers/app.ts';
import { hashPassword, needsRehash, verifyPassword } from '../../src/server/auth/password.ts';
import { RateLimiter } from '../../src/server/auth/rateLimit.ts';

const admin = { email: 'Admin@Example.test', displayName: '管理者', password: 'correct horse battery' };
const member = { email: 'member@example.test', username: 'member', displayName: '成員', password: 'another strong one' };

describe('password hashing', () => {
  it('round-trips, rejects wrong passwords and reports weak parameters', async () => {
    const hash = await hashPassword('秘密密碼 secret');
    expect(hash.startsWith('scrypt$15$8$1$')).toBe(true);
    expect(await verifyPassword(hash, '秘密密碼 secret')).toBe(true);
    expect(await verifyPassword(hash, '秘密密碼 secret!')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash(await hashPassword('x', { logN: 12, r: 8, p: 1, keyLength: 64, saltLength: 16 }))).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows `limit` hits per window and reports when to retry', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 3; i++) expect(limiter.hit('k', 3, 1000, 10_000 + i).allowed).toBe(true);
    const blocked = limiter.hit('k', 3, 1000, 10_500);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.hit('k', 3, 1000, 11_001).allowed).toBe(true);
    limiter.clear('k'); expect(limiter.hit('k', 1, 1000, 11_002).allowed).toBe(true);
  });
  it('keeps each key\'s own window across sweeps', () => {
    const limiter = new RateLimiter();
    limiter.hit('long', 1, 60 * 60_000, 0); // one-hour window
    // A sweep triggered by a short-window key must not forget the long-window attempt.
    limiter.hit('short', 5, 1000, 61_000);
    expect(limiter.hit('long', 1, 60 * 60_000, 62_000).allowed).toBe(false);
  });
});

describe('registration and invites', () => {
  let t: TestApp;
  beforeEach(() => { t = createTestApp(); });
  afterEach(() => t.close());

  it('makes the first user an admin without an invite, then requires valid invites', async () => {
    expect(await (await t.app.request('/api/auth/status')).json()).toEqual({ setupRequired: true });
    const a = t.client();
    const created = await a.register(admin);
    expect(created.status).toBe(201);
    const body = await created.json() as { user: { email: string; role: string }; csrfToken: string };
    expect(body.user).toMatchObject({ email: 'admin@example.test', role: 'admin' });
    expect(a.cookie).toMatch(/^sid=/);
    expect(created.headers.get('set-cookie')).toMatch(/HttpOnly/); expect(created.headers.get('set-cookie')).toMatch(/SameSite=Lax/);
    expect(await (await t.app.request('/api/auth/status')).json()).toEqual({ setupRequired: false });

    const b = t.client();
    expect((await b.register(member)).status).toBe(400);
    expect((await b.register({ ...member, inviteCode: 'nope' })).status).toBe(400);

    const invite = await a.request('POST', '/api/admin/invites', { json: { expiresInHours: 2, note: '給成員' } });
    expect(invite.status).toBe(201);
    const { code, invite: dto } = await invite.json() as { code: string; invite: { id: string } };
    expect((await b.register({ ...member, inviteCode: code })).status).toBe(201);
    expect(await (await b.request('GET', '/api/auth/me')).json()).toMatchObject({ user: { username: 'member', role: 'user' } });
    // single use
    const c = t.client();
    expect((await c.register({ ...member, email: 'third@example.test', username: 'third', inviteCode: code })).status).toBe(400);
    const list = await (await a.request('GET', '/api/admin/invites')).json() as { invites: { id: string; usedAt: number | null }[] };
    expect(list.invites.find(i => i.id === dto.id)?.usedAt).toBe(t.clock.now);
  });

  it('refuses expired and revoked invites and lets admins revoke unused ones', async () => {
    const a = t.client(); await a.register(admin);
    const { code } = await (await a.request('POST', '/api/admin/invites', { json: { expiresInHours: 1 } })).json() as { code: string };
    t.clock.now += 61 * 60 * 1000;
    expect((await t.client().register({ ...member, inviteCode: code })).status).toBe(400);
    const { code: code2, invite } = await (await a.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string; invite: { id: string } };
    expect((await a.request('DELETE', `/api/admin/invites/${invite.id}`)).status).toBe(204);
    expect((await t.client().register({ ...member, inviteCode: code2 })).status).toBe(400);
    expect((await a.request('DELETE', `/api/admin/invites/${invite.id}`)).status).toBe(404);
  });

  it('rejects duplicate emails and usernames with a 409', async () => {
    const a = t.client(); await a.register(admin);
    const { code } = await (await a.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
    expect((await t.client().register({ ...member, email: 'ADMIN@example.test', inviteCode: code })).status).toBe(409);
  });
});

describe('login, sessions and CSRF', () => {
  let t: TestApp;
  beforeEach(async () => { t = createTestApp(); await t.client().register(admin); });
  afterEach(() => t.close());

  it('logs in by email or username, rotates the session and logs out', async () => {
    const c = t.client();
    expect((await c.login('admin@example.test', admin.password)).status).toBe(200);
    const first = c.cookie;
    expect((await c.login('ADMIN@EXAMPLE.TEST', admin.password)).status).toBe(200);
    expect(c.cookie).not.toBe(first);
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    const second = c.cookie;
    expect((await c.request('POST', '/api/auth/logout')).status).toBe(204);
    expect(c.cookie).toBeNull();
    // Logout ends only the current session; another device's session (the first login) keeps working.
    expect((await t.app.request('/api/auth/me', { headers: { cookie: second! } })).status).toBe(401);
    expect((await t.app.request('/api/auth/me', { headers: { cookie: first! } })).status).toBe(200);
  });

  it('gives the same error for wrong password and unknown account, and locks after five tries', async () => {
    const c = t.client();
    const wrong = await c.login('admin@example.test', 'wrong password');
    const unknown = await c.login('nobody@example.test', 'wrong password');
    expect(wrong.status).toBe(401); expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    for (let i = 0; i < 4; i++) await c.login('admin@example.test', 'wrong password');
    const locked = await c.login('admin@example.test', admin.password);
    expect(locked.status).toBe(429); expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    t.clock.now += 16 * 60 * 1000;
    expect((await c.login('admin@example.test', admin.password)).status).toBe(200);
  });

  it('requires the CSRF header and a same-origin Origin on mutations', async () => {
    const c = t.client(); await c.login('admin@example.test', admin.password);
    expect((await c.request('POST', '/api/admin/invites', { json: {}, csrf: false })).status).toBe(403);
    expect((await c.request('POST', '/api/admin/invites', { json: {}, headers: { 'x-csrf-token': 'bad' }, csrf: false })).status).toBe(403);
    expect((await c.request('POST', '/api/admin/invites', { json: {}, origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.request('POST', '/api/admin/invites', { json: {}, origin: null })).status).toBe(201);
    expect((await c.request('POST', '/api/admin/invites', { json: {} })).status).toBe(201);
  });

  it('expires idle sessions after 30 days and slides them while in use', async () => {
    const c = t.client(); await c.login('admin@example.test', admin.password);
    t.clock.now += 20 * 24 * 60 * 60 * 1000;
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    t.clock.now += 20 * 24 * 60 * 60 * 1000;
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    t.clock.now += 31 * 24 * 60 * 60 * 1000;
    expect((await c.request('GET', '/api/auth/me')).status).toBe(401);
  });

  it('changes the password and invalidates other sessions', async () => {
    const c = t.client(); await c.login('admin@example.test', admin.password);
    const other = t.client(); await other.login('admin@example.test', admin.password);
    expect((await c.request('POST', '/api/auth/password', { json: { currentPassword: 'nope', newPassword: 'brand new password' } })).status).toBe(400);
    expect((await c.request('POST', '/api/auth/password', { json: { currentPassword: admin.password, newPassword: 'brand new password' } })).status).toBe(204);
    expect((await c.request('GET', '/api/auth/me')).status).toBe(200);
    expect((await other.request('GET', '/api/auth/me')).status).toBe(401);
    expect((await t.client().login('admin@example.test', 'brand new password')).status).toBe(200);
  });
});

describe('admin user management', () => {
  let t: TestApp;
  beforeEach(() => { t = createTestApp(); });
  afterEach(() => t.close());

  it('lists users, disables accounts (killing their sessions) and protects the last admin', async () => {
    const a = t.client(); await a.register(admin);
    const { code } = await (await a.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
    const b = t.client(); await b.register({ ...member, inviteCode: code });
    expect((await b.request('GET', '/api/admin/users')).status).toBe(403);
    const users = await (await a.request('GET', '/api/admin/users')).json() as { users: { email: string; role: string; pageCount: number }[] };
    expect(users.users.map(u => u.email)).toEqual(['admin@example.test', 'member@example.test']);
    const me = await (await a.request('GET', '/api/auth/me')).json() as { user: { id: string } };
    const memberId = (await (await b.request('GET', '/api/auth/me')).json() as { user: { id: string } }).user.id;
    expect((await a.request('PATCH', `/api/admin/users/${me.user.id}`, { json: { disabled: true } })).status).toBe(409);
    expect((await a.request('PATCH', `/api/admin/users/${me.user.id}`, { json: { role: 'user' } })).status).toBe(409);
    expect((await a.request('PATCH', `/api/admin/users/${memberId}`, { json: { disabled: true } })).status).toBe(200);
    expect((await b.request('GET', '/api/auth/me')).status).toBe(401);
    expect((await t.client().login('member', member.password)).status).toBe(403);
    expect((await a.request('PATCH', `/api/admin/users/${memberId}`, { json: { disabled: false, role: 'admin' } })).status).toBe(200);
    expect((await t.client().login('member', member.password)).status).toBe(200);
    expect((await a.request('PATCH', '/api/admin/users/missing', { json: { disabled: true } })).status).toBe(404);
  });
});
