import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.ts';
import type { TestApp, TestClient } from '../helpers/app.ts';
import { syntheticPng } from '../helpers/png.ts';
import { sniffMime } from '../../src/server/services/storage.ts';

const admin = { email: 'admin@example.test', displayName: '管理者', password: 'correct horse battery' };

function upload(c: TestClient, bytes: Uint8Array, name: string, type: string) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  return c.request('POST', '/api/files', { body: form });
}

describe('mime sniffing', () => {
  it('trusts bytes over declared types', () => {
    expect(sniffMime(syntheticPng(), 'text/plain')).toBe('image/png');
    expect(sniffMime(new TextEncoder().encode('hello'), 'image/png')).toBe('application/octet-stream');
    expect(sniffMime(new TextEncoder().encode('hello'), 'text/plain')).toBe('text/plain');
    expect(sniffMime(new TextEncoder().encode('<svg/>'), 'image/svg+xml')).toBe('image/svg+xml');
    expect(sniffMime(new TextEncoder().encode('x'), 'application/x-msdownload')).toBe('application/octet-stream');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.4'), undefined)).toBe('application/pdf');
  });
});

describe('files', () => {
  let t: TestApp; let c: TestClient;
  beforeEach(async () => { t = createTestApp(); c = t.client(); await c.register(admin); });
  afterEach(() => t.close());

  it('stores an image once, serves it inline with caching headers, and supports conditional requests', async () => {
    const png = syntheticPng(20, 10);
    const first = await upload(c, png, '照片 (1).png', 'image/png');
    expect(first.status).toBe(201);
    const dto = await first.json() as { id: string; url: string; mime: string; size: number; sha256: string; name: string };
    expect(dto).toMatchObject({ mime: 'image/png', size: png.byteLength, name: '照片 (1).png' });
    expect(dto.url).toBe(`/api/files/${dto.id}/${encodeURIComponent('照片 (1).png')}`);
    const second = await upload(c, png, 'again.png', 'image/png');
    const dto2 = await second.json() as { id: string; sha256: string };
    expect(dto2.sha256).toBe(dto.sha256); expect(dto2.id).not.toBe(dto.id);
    const blobs = readdirSync(join(t.dataDir, 'files', dto.sha256.slice(0, 2), dto.sha256.slice(2, 4)));
    expect(blobs).toEqual([dto.sha256]);
    expect(readdirSync(join(t.dataDir, 'tmp'))).toEqual([]);

    const served = await c.request('GET', dto.url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
    expect(served.headers.get('cache-control')).toBe('private, no-cache');
    expect(served.headers.get('x-notes-user')).toBeTruthy();
    expect(served.headers.get('content-security-policy')).toBeNull();
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
    const cached = await c.request('GET', dto.url, { headers: { 'if-none-match': served.headers.get('etag')! } });
    expect(cached.status).toBe(304);
  });

  it.each([
    ['document.pdf', '%PDF-1.4', 'application/pdf'],
    ['sound.wav', 'RIFF0000WAVE', 'audio/wav'],
    ['movie.mp4', '0000ftypisom', 'video/mp4'],
  ])('serves non-image %s as a sandboxed attachment', async (name, content, mime) => {
    const uploaded = await upload(c, new TextEncoder().encode(content), name, mime);
    expect(uploaded.status).toBe(201);
    const { url } = await uploaded.json() as { url: string };
    const served = await c.request('GET', url);
    expect(served.headers.get('content-type')).toBe(mime);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(served.headers.get('content-security-policy')).toBe('sandbox');
    expect(await served.text()).toBe(content);
  });

  it('serves non-media as sandboxed attachments and refuses empty, oversized or foreign files', async () => {
    const text = await upload(c, new TextEncoder().encode('# 筆記\n'), 'notes.md', 'text/markdown');
    const dto = await text.json() as { id: string; url: string; mime: string };
    expect(dto.mime).toBe('text/markdown');
    const served = await c.request('GET', dto.url);
    expect(served.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(served.headers.get('content-security-policy')).toBe('sandbox');
    expect((await upload(c, new Uint8Array(0), 'empty.png', 'image/png')).status).toBe(400);
    const big = new Uint8Array(t.deps.config.maxUploadBytes + 1);
    expect((await upload(c, big, 'big.bin', 'application/octet-stream')).status).toBe(413);
    const { code } = await (await c.request('POST', '/api/admin/invites', { json: {} })).json() as { code: string };
    const other = t.client();
    await other.register({ email: 'o@example.test', displayName: 'O', password: 'other strong pass', inviteCode: code });
    expect((await other.request('GET', dto.url)).status).toBe(404);
    expect((await other.request('DELETE', `/api/files/${dto.id}`)).status).toBe(404);
  });

  it('deletes rows and removes the blob only when no row references it', async () => {
    const png = syntheticPng(8, 8, 7);
    const a = await (await upload(c, png, 'a.png', 'image/png')).json() as { id: string; sha256: string };
    const b = await (await upload(c, png, 'b.png', 'image/png')).json() as { id: string };
    const path = join(t.dataDir, 'files', a.sha256.slice(0, 2), a.sha256.slice(2, 4), a.sha256);
    expect((await c.request('DELETE', `/api/files/${a.id}`)).status).toBe(204);
    expect(existsSync(path)).toBe(true);
    expect((await c.request('DELETE', `/api/files/${b.id}`)).status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect((await c.request('GET', `/api/files/${b.id}`)).status).toBe(404);
  });
});
