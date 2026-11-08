// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_LOST_EVENT, ApiError, api, setCsrfToken } from '../../src/client/api/client.ts';

const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null); });

  it('sends JSON with the CSRF header on mutations and same-origin credentials', async () => {
    const fetchMock = vi.fn(async () => reply(201, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('token-1');
    await expect(api('POST', '/api/x', { json: { a: 1 } })).resolves.toEqual({ ok: 1 });
    await api('GET', '/api/x');
    const [, postInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, getInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(postInit.credentials).toBe('same-origin');
    expect((postInit.headers as Record<string, string>)['x-csrf-token']).toBe('token-1');
    expect((postInit.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(postInit.body).toBe('{"a":1}');
    expect((getInit.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('turns error bodies into ApiError and announces lost sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { code: 'unauthorized', message: '請先登入。' } })));
    const lost = vi.fn(); window.addEventListener(AUTH_LOST_EVENT, lost);
    await expect(api('GET', '/api/auth/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized', message: '請先登入。' });
    expect(lost).toHaveBeenCalledTimes(1);
    // A failed login is not a lost session.
    await expect(api('POST', '/api/auth/login', { json: {} })).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_LOST_EVENT, lost);
  });

  it('returns undefined for 204 and a friendly error when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api('DELETE', '/api/x')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api('GET', '/api/x')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('無法連線') });
  });
});
