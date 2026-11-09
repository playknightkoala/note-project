import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';

async function worker(owner: string | null = 'user-a') {
  const indexedDB = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('notes-offline-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('records', 'readwrite');
      if (owner) tx.objectStore('records').put({ id: owner }, 'user');
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const normalize = (request: string | { url: string }) => typeof request === 'string' ? request : request.url;
  const cacheApi = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        match: async (key: string | { url: string }) => entries.get(normalize(key))?.clone(),
        put: async (key: string | { url: string }, response: Response) => { entries.set(normalize(key), response); },
        keys: async () => [...entries.keys()],
        delete: async (key: string) => entries.delete(key),
        addAll: async () => {},
      };
    },
  };
  const fetcher = vi.fn(async (_request: unknown, _options?: unknown): Promise<Response> => { throw new TypeError('offline'); });
  runInNewContext(readFileSync('src/client/offline/service-worker.js', 'utf8'), {
    self: { location: { origin: 'https://notes.example.test' }, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
    indexedDB, caches: cacheApi, fetch: fetcher, URL, Response,
  });
  const request = async (path: string, mode = 'cors', method = 'GET'): Promise<Response | undefined> => {
    let result: Promise<Response> | undefined;
    listeners.get('fetch')!({ request: { url: `https://notes.example.test${path}`, method, mode }, respondWith: (response: Promise<Response>) => { result = response; } });
    return result;
  };
  return { request, fetcher, stores, cacheApi };
}

it('serves cached shell on offline deep-link navigation but never intercepts JSON or writes', async () => {
  const w = await worker();
  await (await w.cacheApi.open('__NOTES_SHELL__')).put('/', new Response('<html>離線介面</html>'));
  expect(await (await w.request('/p/some-id', 'navigate'))?.text()).toContain('離線介面');
  expect(await w.request('/api/auth/me')).toBeUndefined();
  expect(await w.request('/api/pages/some-id', 'navigate')).toBeUndefined();
  expect(await w.request('/api/files/file-id', 'cors', 'DELETE')).toBeUndefined();
});

it('isolates attachment caches by account and preserves sandbox/download headers', async () => {
  const w = await worker();
  const path = '/api/files/file-id/name.pdf';
  w.fetcher.mockResolvedValueOnce(new Response('synthetic file', { headers: { 'x-notes-user': 'user-a', 'content-length': '14', 'content-security-policy': 'sandbox', 'content-disposition': 'attachment' } }));
  expect((await w.request(path))?.status).toBe(200);
  const cached = await w.request(path);
  expect(await cached?.text()).toBe('synthetic file');
  expect(cached?.headers.get('content-security-policy')).toBe('sandbox');
  expect(cached?.headers.get('content-disposition')).toBe('attachment');
  w.fetcher.mockResolvedValueOnce(new Response('revoked', { status: 401 }));
  expect((await w.request(path))?.status).toBe(401);
  const other = await worker('user-b');
  other.stores.set('notes-files-user-a', w.stores.get('notes-files-user-a')!);
  expect((await other.request(path))?.status).toBe(503);
});
