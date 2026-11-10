import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';

async function worker(owner: string | null = 'user-a', limitMB?: number, clients: { id: string; postMessage: ReturnType<typeof vi.fn> }[] = [], assets: string[] = []) {
  const indexedDB = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('notes-offline-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('records', 'readwrite');
      if (owner) tx.objectStore('records').put({ id: owner }, 'user');
      if (owner && limitMB) tx.objectStore('records').put({ limitBytes: limitMB * 1024 * 1024 }, `attachments:${owner}`);
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const puts: string[] = [];
  const registration: { installing?: unknown; waiting?: unknown } = {};
  const normalize = (request: string | { url: string }) => typeof request === 'string' ? request : request.url;
  const cacheApi = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        match: async (key: string | { url: string }) => entries.get(normalize(key))?.clone(),
        put: async (key: string | { url: string }, response: Response) => { puts.push(normalize(key)); entries.set(normalize(key), response); },
        keys: async () => [...entries.keys()],
        delete: async (key: string) => entries.delete(key),
        addAll: async (keys: string[]) => { for (const key of keys) entries.set(key, new Response(`fetched ${key}`)); },
      };
    },
  };
  const fetcher = vi.fn(async (_request: unknown, _options?: unknown): Promise<Response> => { throw new TypeError('offline'); });
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync('src/client/offline/service-worker.js', 'utf8').replace('/* __NOTES_ASSETS__ */ []', JSON.stringify(assets)), {
    self: { skipWaiting, registration, clients: { claim: async () => {}, matchAll: async () => clients }, location: { origin: 'https://notes.example.test' }, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
    indexedDB, caches: cacheApi, fetch: fetcher, URL, Response,
  });
  const request = async (path: string, mode = 'cors', method = 'GET'): Promise<Response | undefined> => {
    let result: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    listeners.get('fetch')!({ request: { url: `https://notes.example.test${path}`, method, mode }, respondWith: (response: Promise<Response>) => { result = response; }, waitUntil: (work: Promise<unknown>) => { background.push(work); } });
    if (!result) return undefined;
    const response = await result;
    // Caching continues after the page has its response; tests wait for it so the stores are settled.
    await Promise.all(background);
    return response;
  };
  const activate = async () => {
    let work: Promise<void> | undefined;
    listeners.get('activate')!({ waitUntil: (promise: Promise<void>) => { work = promise; } });
    await work;
  };
  const setLimit = async (limitMB: number) => {
    await new Promise<void>(resolve => {
      const r = indexedDB.open('notes-offline-v1', 1);
      r.onsuccess = () => {
        const tx = r.result.transaction('records', 'readwrite');
        tx.objectStore('records').put({ limitBytes: limitMB * 1024 * 1024 }, `attachments:${owner}`);
        tx.oncomplete = () => { r.result.close(); resolve(); };
      };
    });
    let work: Promise<void> | undefined;
    listeners.get('message')!({ data: { type: 'notes:trim-files' }, waitUntil: (promise: Promise<void>) => { work = promise; } });
    await work;
  };
  const message = async (data: unknown, source?: { id: string }, ports?: { postMessage: ReturnType<typeof vi.fn> }[]) => {
    let work: Promise<void> | undefined;
    listeners.get('message')!({ data, source, ports, waitUntil: (promise: Promise<void>) => { work = promise; } });
    await work;
  };
  const dispatchFetch = (path: string, handlers: { respondWith: (response: Promise<Response>) => void; waitUntil: (work: Promise<unknown>) => void }) =>
    listeners.get('fetch')!({ request: { url: `https://notes.example.test${path}`, method: 'GET', mode: 'cors' }, ...handlers });
  return { request, fetcher, stores, cacheApi, setLimit, message, skipWaiting, registration, puts, activate, dispatchFetch };
}

it('reports its version and activates only for an explicit request targeting that version', async () => {
  const w = await worker(), port = { postMessage: vi.fn() };
  await w.message({ type: 'notes:get-version' }, undefined, [port]);
  expect(port.postMessage).toHaveBeenCalledWith({ version: '__NOTES_VERSION__' });
  await w.message({ type: 'notes:activate-update', version: 'wrong-version' });
  expect(w.skipWaiting).not.toHaveBeenCalled();
  await w.message({ type: 'notes:activate-update', version: '__NOTES_VERSION__' });
  expect(w.skipWaiting).toHaveBeenCalledOnce();
});

it('keeps old assets until every open tab reports the new version', async () => {
  const clients = [{ id: 'old-tab', postMessage: vi.fn() }, { id: 'new-tab', postMessage: vi.fn() }];
  const w = await worker('user-a', undefined, clients);
  await w.cacheApi.open('notes-shell-old'); await w.cacheApi.open('notes-files-user-a');
  await w.message({ type: 'notes:client-version', version: '__NOTES_VERSION__' }, clients[1]);
  expect(w.stores.has('notes-shell-old')).toBe(true);
  await w.message({ type: 'notes:client-version', version: '1.0.0' }, clients[0]);
  expect(w.stores.has('notes-shell-old')).toBe(true);
  await w.message({ type: 'notes:client-version', version: '__NOTES_VERSION__' }, clients[0]);
  expect(w.stores.has('notes-shell-old')).toBe(false);
  expect(w.stores.has('notes-files-user-a')).toBe(true);
});

it('serves an older tab’s cached assets after the new worker takes control', async () => {
  const w = await worker();
  await (await w.cacheApi.open('notes-shell-previous')).put('https://notes.example.test/assets/previous.js', new Response('previous module'));
  expect(await (await w.request('/assets/previous.js'))?.text()).toBe('previous module');
  expect(w.fetcher).not.toHaveBeenCalled();
});

it('serves cached shell on offline deep-link navigation but never intercepts JSON or writes', async () => {
  const w = await worker();
  await (await w.cacheApi.open('__NOTES_SHELL__')).put('/', new Response('<html>離線介面</html>'));
  expect(await (await w.request('/p/some-id', 'navigate'))?.text()).toContain('離線介面');
  expect(await w.request('/api/auth/me')).toBeUndefined();
  expect(await w.request('/api/pages/some-id', 'navigate')).toBeUndefined();
  expect(await w.request('/api/files/file-id', 'cors', 'DELETE')).toBeUndefined();
});

it('caches attachments larger than 20 MB and evicts by total bytes rather than a file count', async () => {
  const w = await worker('user-a', 100);
  const file = (mb: number) => new Response('synthetic', { headers: { 'x-notes-user': 'user-a', 'content-length': String(mb * 1024 * 1024) } });
  w.fetcher.mockResolvedValueOnce(file(60));
  await w.request('/api/files/older.pdf');
  w.fetcher.mockResolvedValueOnce(file(60));
  await w.request('/api/files/newer.pdf');
  expect((await w.request('/api/files/older.pdf'))?.status).toBe(503);
  expect((await w.request('/api/files/newer.pdf'))?.status).toBe(200);
  w.fetcher.mockResolvedValueOnce(file(101));
  expect((await w.request('/api/files/too-large.pdf'))?.status).toBe(200);
  expect((await w.request('/api/files/too-large.pdf'))?.status).toBe(503);
  // Small attachments are limited by bytes, so more than 100 fit.
  for (let index = 0; index < 102; index++) {
    w.fetcher.mockResolvedValueOnce(new Response('x', { headers: { 'x-notes-user': 'user-a', 'content-length': '1' } }));
    await w.request(`/api/files/small-${index}`);
  }
  expect(w.stores.get('notes-files-user-a')?.size).toBe(103);
});

it('serializes concurrent cache writes and trims immediately after lowering the budget', async () => {
  const w = await worker('user-a', 500);
  w.fetcher.mockImplementation(async () => new Response('synthetic', { headers: { 'x-notes-user': 'user-a', 'content-length': String(60 * 1024 * 1024) } }));
  await Promise.all([w.request('/api/files/one'), w.request('/api/files/two'), w.request('/api/files/three')]);
  expect(w.stores.get('notes-files-user-a')?.size).toBe(3);
  await w.setLimit(100);
  expect(w.stores.get('notes-files-user-a')?.size).toBe(1);
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

it('never deletes the shell of a newer worker that is still waiting to activate', async () => {
  const clients = [{ id: 'tab', postMessage: vi.fn() }];
  const w = await worker('user-a', undefined, clients);
  await w.cacheApi.open('notes-shell-newer');
  w.registration.waiting = {};
  await w.message({ type: 'notes:client-version', version: '__NOTES_VERSION__' }, clients[0]);
  expect(w.stores.has('notes-shell-newer')).toBe(true);
  w.registration.waiting = undefined; w.registration.installing = {};
  await w.message({ type: 'notes:client-version', version: '__NOTES_VERSION__' }, clients[0]);
  expect(w.stores.has('notes-shell-newer')).toBe(true);
  // Once this worker is the newest one again, leftovers are removed as before.
  w.registration.installing = undefined;
  await w.message({ type: 'notes:client-version', version: '__NOTES_VERSION__' }, clients[0]);
  expect(w.stores.has('notes-shell-newer')).toBe(false);
});

it('restores a missing app shell entry when the worker activates', async () => {
  const w = await worker('user-a', undefined, [], ['/', '/assets/app.js']);
  await (await w.cacheApi.open('__NOTES_SHELL__')).put('/assets/app.js', new Response('module'));
  await w.activate();
  const shell = w.stores.get('__NOTES_SHELL__')!;
  expect([...shell.keys()].sort()).toEqual(['/', '/assets/app.js']);
  expect(await shell.get('/assets/app.js')!.clone().text()).toBe('module');
  expect(await (await w.request('/p/some-id', 'navigate'))?.text()).toBe('fetched /');
});

it('lets the browser revalidate attachments and does not rewrite an unchanged one', async () => {
  const w = await worker();
  const file = () => new Response('synthetic file', { headers: { 'x-notes-user': 'user-a', 'content-length': '14', etag: '"abc"' } });
  w.fetcher.mockResolvedValueOnce(file());
  expect(await (await w.request('/api/files/file-id'))?.text()).toBe('synthetic file');
  expect(w.fetcher.mock.calls[0]?.[1]).toBeUndefined();
  expect(w.puts).toHaveLength(1);
  w.fetcher.mockResolvedValueOnce(file());
  expect((await w.request('/api/files/file-id'))?.status).toBe(200);
  expect(w.puts).toHaveLength(1);
  w.fetcher.mockResolvedValueOnce(new Response('changed content', { headers: { 'x-notes-user': 'user-a', 'content-length': '15', etag: '"def"' } }));
  await w.request('/api/files/file-id');
  expect(w.puts).toHaveLength(2);
  expect(await (await w.request('/api/files/file-id'))?.text()).toBe('changed content');
});

it('answers with the attachment before the offline copy has been written', async () => {
  const w = await worker();
  const cache = await w.cacheApi.open('notes-files-user-a');
  let release = () => {};
  const original = cache.put;
  w.cacheApi.open = async () => ({ ...cache, put: async (key: string | { url: string }, response: Response) => { await new Promise<void>(resolve => { release = resolve; }); await original(key, response); } });
  w.fetcher.mockResolvedValueOnce(new Response('synthetic file', { headers: { 'x-notes-user': 'user-a', 'content-length': '14' } }));
  let result: Promise<Response> | undefined;
  const background: Promise<unknown>[] = [];
  const listeners = { respondWith: (response: Promise<Response>) => { result = response; }, waitUntil: (work: Promise<unknown>) => { background.push(work); } };
  w.dispatchFetch('/api/files/slow', listeners);
  expect(await (await result!).text()).toBe('synthetic file');
  expect(w.stores.get('notes-files-user-a')?.size).toBe(0);
  await vi.waitFor(() => expect(background).toHaveLength(1));
  await vi.waitFor(() => { release(); expect(w.stores.get('notes-files-user-a')?.size).toBe(1); });
});

it('does not cache an HTML answer under an asset URL', async () => {
  const w = await worker();
  w.fetcher.mockResolvedValueOnce(new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=UTF-8' } }));
  expect((await w.request('/assets/gone.js'))?.status).toBe(200);
  expect(w.stores.get('__NOTES_SHELL__')?.size ?? 0).toBe(0);
  w.fetcher.mockResolvedValueOnce(new Response('export {}', { headers: { 'content-type': 'text/javascript' } }));
  await w.request('/assets/real.js');
  expect(w.stores.get('__NOTES_SHELL__')?.size).toBe(1);
});
