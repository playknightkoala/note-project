import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import { silentLogger } from '../../src/server/logger.ts';
import { hashPassword } from '../../src/server/auth/password.ts';

// What is true when a request's headers arrive may no longer be true when its body has: these tests hold a body
// back, change something in between, and then let the body through.

const password = () => `synthetic ${crypto.randomUUID()}`;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const jsonHeaders = { 'content-type': 'application/json' };

/** A body whose first bytes arrive at once and whose rest waits for `release`. */
function held(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let release!: () => void, step = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step++ === 0) { controller.enqueue(bytes.slice(0, 5)); return; }
      await gate;
      controller.enqueue(bytes.slice(5)); controller.close();
    },
  });
  return { body, release };
}
/** A body without a declared length that reports how much of it was asked for. */
function counted(bytes: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= bytes) { controller.close(); return; }
      controller.enqueue(new Uint8Array(64 * 1024).fill(97)); pulled += 64 * 1024;
    },
  });
  return { body, pulled: () => pulled };
}
const paragraph = (text: string) => ({ id: crypto.randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });

describe('requests whose body arrives late', () => {
  let t: TestApp;
  let owner: TestClient & { password: string; id: string };
  beforeEach(async () => { t = createTestApp(); owner = await account('owner@example.test'); });
  afterEach(() => { vi.restoreAllMocks(); t.close(); });

  async function account(email: string): Promise<TestClient & { password: string; id: string }> {
    const client = t.client(), secret = password();
    const inviteCode = owner ? ((await (await owner.request('POST', '/api/admin/invites', { json: { expiresInHours: 1 } })).json()) as { code: string }).code : undefined;
    const response = await client.register({ email, displayName: email, password: secret, ...(inviteCode ? { inviteCode } : {}) });
    expect(response.status).toBe(201);
    return Object.assign(client, { password: secret, id: ((await response.json()) as { user: { id: string } }).user.id });
  }
  async function signIn(email: string, secret: string): Promise<TestClient> {
    const client = t.client();
    expect((await client.login(email, secret)).status).toBe(200);
    return client;
  }
  /** Registered straight in the database: the owner's session may be gone by the time this is needed. */
  async function account2(): Promise<{ id: string; password: string }> {
    const secret = password(), id = crypto.randomUUID();
    t.deps.db.run('INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, 'second@example.test', '第二位', await hashPassword(secret), 'user', 0, 0);
    expect((await t.client().login('second@example.test', secret)).status).toBe(200);
    return { id, password: secret };
  }
  const createPage = async (title: string) => ((await (await owner.request('POST', '/api/pages', { json: { title } })).json()) as { page: { id: string; version: number } }).page;
  const contentOf = async (id: string) => JSON.stringify(((await (await owner.request('GET', `/api/pages/${id}`)).json()) as { page: { content: unknown[] } }).page.content);

  it('reads nothing of a body before the sender is known to be signed in', async () => {
    const anonymous = counted(6 * 1024 * 1024);
    expect((await t.client().request('POST', '/api/pages', { headers: jsonHeaders, body: anonymous.body })).status).toBe(401);
    expect(anonymous.pulled()).toBeLessThan(256 * 1024);
    // Signed in, the same body is read and cut off at the limit.
    const large = counted(9 * 1024 * 1024);
    expect((await owner.request('POST', '/api/pages', { headers: jsonHeaders, body: large.body })).status).toBe(413);
    expect(large.pulled()).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('reads nothing of an upload that is over the rate limit', async () => {
    for (let i = 0; i < 60; i++) t.deps.rateLimiter.hit(`upload:${owner.id}`, 60, 60_000, t.deps.now());
    const upload = counted(4 * 1024 * 1024);
    expect((await owner.request('POST', '/api/files', { headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: upload.body })).status).toBe(429);
    expect(upload.pulled()).toBeLessThan(256 * 1024);
  });

  it('does not let a password change that was already on its way survive the sign-out of its session', async () => {
    const thief = await signIn('owner@example.test', owner.password), stolen = password(), chosen = password();
    const late = held({ currentPassword: owner.password, newPassword: stolen });
    const pending = thief.request('POST', '/api/auth/password', { headers: jsonHeaders, body: late.body });
    await tick();
    expect((await owner.request('POST', '/api/auth/password', { json: { currentPassword: owner.password, newPassword: chosen } })).status).toBe(204);
    late.release();
    expect((await pending).status).toBe(401);
    expect((await t.client().login('owner@example.test', stolen)).status).toBe(401);
    expect((await t.client().login('owner@example.test', chosen)).status).toBe(200);
  });

  it('lets only one of two password changes that verified the same password through', async () => {
    const other = await signIn('owner@example.test', owner.password);
    const first = password(), second = password();
    const answers = await Promise.all([
      owner.request('POST', '/api/auth/password', { json: { currentPassword: owner.password, newPassword: first } }),
      other.request('POST', '/api/auth/password', { json: { currentPassword: owner.password, newPassword: second } }),
    ]);
    // The one that wrote first signed the other session out (401) or, at the latest, changed the hash under it (409).
    expect(answers.map(answer => answer.status).sort()).toEqual(expect.arrayContaining([204]));
    expect(answers.filter(answer => answer.status === 204)).toHaveLength(1);
    const logins = await Promise.all([first, second].map(async secret => (await t.client().login('owner@example.test', secret)).status));
    expect(logins.filter(status => status === 200)).toHaveLength(1);
  });

  it('does not sign in with a password that was changed, or an account that was disabled, while it was being verified', async () => {
    const replacement = await hashPassword(password());
    const signingIn = t.client().login('owner@example.test', owner.password);
    await tick();
    // What a password change does, while the sign-in above is still busy with the old password.
    t.deps.db.run('UPDATE users SET password_hash = ? WHERE id = ?', replacement, owner.id);
    t.deps.db.run('DELETE FROM sessions WHERE user_id = ?', owner.id);
    expect((await signingIn).status).toBe(401);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', owner.id)?.n).toBe(0);

    // Two sign-ins at once on a hash that is due for an upgrade: whichever upgrades it first must not make the
    // other one, which gave the right password too, look like a wrong guess.
    const legacy = password();
    t.deps.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(legacy, { logN: 15, r: 8, p: 1, keyLength: 64, saltLength: 16 }), owner.id);
    const both = await Promise.all([t.client().login('owner@example.test', legacy), t.client().login('owner@example.test', legacy)]);
    expect(both.map(answer => answer.status)).toEqual([200, 200]);
    expect(t.deps.db.get<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', owner.id)?.h).toMatch(/^scrypt\$15\$8\$3\$/);

    const second = await account2();
    const disabledMeanwhile = t.client().login('second@example.test', second.password);
    await tick();
    t.deps.db.run('UPDATE users SET disabled_at = ? WHERE id = ?', t.deps.now(), second.id);
    expect((await disabledMeanwhile).status).toBe(403);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', second.id)?.n).toBe(1);
  });

  it('limits guesses at the current password and never logs what was typed', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');
    for (let i = 0; i < 5; i++) expect((await owner.request('POST', '/api/auth/password', { json: { currentPassword: `wrong ${i}`, newPassword: password() } })).status).toBe(400);
    expect((await owner.request('POST', '/api/auth/password', { json: { currentPassword: owner.password, newPassword: password() } })).status).toBe(429);
    const typed = `typed-by-mistake ${crypto.randomUUID()}`;
    expect((await t.client().login(typed, typed)).status).toBe(401);
    expect((await t.client().login('owner@example.test', typed)).status).toBe(401);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('login failed');
    expect(logged).toContain(owner.id);
    expect(logged).not.toContain(typed);
    expect(logged).not.toContain('owner@example.test');
  });

  it('judges a member\'s right to write when the body has arrived, not when the request began', async () => {
    const member = await account('member@example.test');
    const page = await createPage('共用');
    const add = (role: string) => owner.request('PUT', `/api/pages/${page.id}/share/members`, { json: { email: 'member@example.test', role } });
    const remove = () => owner.request('DELETE', `/api/pages/${page.id}/share/members/${member.id}`);
    expect((await add('editor')).status).toBe(200);

    const write = held({ content: [paragraph('移除後才送達')] });
    const writing = member.request('PUT', `/api/pages/${page.id}/content`, { headers: { ...jsonHeaders, 'if-match': `"${page.version}"` }, body: write.body });
    await tick();
    expect((await remove()).status).toBe(200);
    write.release();
    expect((await writing).status).toBe(404);
    expect(await contentOf(page.id)).not.toContain('移除後才送達');

    expect((await add('editor')).status).toBe(200);
    const rename = held({ title: '移除後改名' });
    const renaming = member.request('PATCH', `/api/pages/${page.id}`, { headers: jsonHeaders, body: rename.body });
    await tick();
    // Downgraded rather than removed: the answer is "forbidden", and nothing is renamed.
    expect((await owner.request('PATCH', `/api/pages/${page.id}/share/members/${member.id}`, { json: { role: 'viewer' } })).status).toBe(200);
    rename.release();
    expect((await renaming).status).toBe(403);

    const comment = held({ quote: '引文', blockIds: ['b'], text: '移除後的留言' });
    const commenting = member.request('POST', `/api/pages/${page.id}/annotations`, { headers: jsonHeaders, body: comment.body });
    await tick();
    expect((await remove()).status).toBe(200);
    comment.release();
    expect((await commenting).status).toBe(404);
    expect(((await (await owner.request('GET', `/api/pages/${page.id}/annotations`)).json()) as { annotations: unknown[] }).annotations).toEqual([]);
  });

  it('ends the request of an account that was disabled, or an administrator that was demoted, while its body was on its way', async () => {
    const second = await account('second@example.test');
    expect((await owner.request('PATCH', `/api/admin/users/${second.id}`, { json: { role: 'admin' } })).status).toBe(200);
    const invite = held({ expiresInHours: 1 });
    const inviting = second.request('POST', '/api/admin/invites', { headers: jsonHeaders, body: invite.body });
    await tick();
    expect((await owner.request('PATCH', `/api/admin/users/${second.id}`, { json: { role: 'user' } })).status).toBe(200);
    invite.release();
    expect((await inviting).status).toBe(403);

    const create = held({ title: '停用後才送達' });
    const creating = second.request('POST', '/api/pages', { headers: jsonHeaders, body: create.body });
    await tick();
    expect((await owner.request('PATCH', `/api/admin/users/${second.id}`, { json: { disabled: true } })).status).toBe(200);
    create.release();
    expect((await creating).status).toBe(401);
    expect(t.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE user_id = ?', second.id)?.n).toBe(0);
  });

  it('takes several uploads at once and keeps an account within its storage limit', async () => {
    const upload = (client: TestClient, bytes: number) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes).fill(7)], { type: 'application/octet-stream' }), 'data.bin');
      return client.request('POST', '/api/files', { body: form });
    };
    const answers = await Promise.all(Array.from({ length: 7 }, () => upload(owner, 2048)));
    expect(answers.map(answer => answer.status)).toEqual(Array(7).fill(201));
    t.close();
    t = createTestApp({ MAX_ACCOUNT_STORAGE_MB: '1' });
    const limited = t.client();
    await limited.register({ email: 'limited@example.test', displayName: '限額', password: password() });
    expect((await upload(limited, 700 * 1024)).status).toBe(201);
    const refused = await upload(limited, 700 * 1024);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: 'payload_too_large', message: '附件空間已達上限（1 MB），無法再加入檔案。' } });
    expect((await upload(limited, 100 * 1024)).status).toBe(201);
  });
});
