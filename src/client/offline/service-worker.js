/* The build replaces these constants with a versioned shell and its complete asset list. */
const SHELL = '__NOTES_SHELL__';
const ASSETS = /* __NOTES_ASSETS__ */ [];
const FILE_PREFIX = 'notes-files-';
const DEFAULT_FILE_BUDGET = 500 * 1024 * 1024;
let fileCacheTask = Promise.resolve();
function serializeFileCache(task) {
  const result = fileCacheTask.then(task);
  fileCacheTask = result.catch(() => {});
  return result;
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS)));
  // Keep the running editor on its current version. The new worker activates after its tabs close.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('notes-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function localRecord(key) {
  return new Promise(resolve => {
    const request = indexedDB.open('notes-offline-v1', 1);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) { db.close(); resolve(null); return; }
      const read = db.transaction('records').objectStore('records').get(key);
      read.onsuccess = () => { db.close(); resolve(read.result ?? null); };
      read.onerror = () => { db.close(); resolve(null); };
    };
  });
}
async function currentUser() { return (await localRecord('user'))?.id ?? null; }
async function fileBudget(owner) {
  const value = (await localRecord(`attachments:${owner}`))?.limitBytes;
  return Number.isSafeInteger(value) && value >= 100 * 1024 * 1024 && value <= 10_000 * 1024 * 1024 ? value : DEFAULT_FILE_BUDGET;
}
async function trimFiles(cache, budget) {
  const entries = [];
  let total = 0;
  for (const key of await cache.keys()) {
    const response = await cache.match(key);
    const size = Number(response?.headers.get('content-length'));
    if (!response?.headers.has('content-length') || !Number.isFinite(size) || size < 0) { await cache.delete(key); continue; }
    total += size;
    entries.push({ key, size });
  }
  for (const { key, size } of entries) {
    if (total <= budget) break;
    await cache.delete(key); total -= size;
  }
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'notes:trim-files') return;
  event.waitUntil(serializeFileCache(async () => {
    const owner = await currentUser();
    if (owner) await trimFiles(await caches.open(FILE_PREFIX + owner), await fileBudget(owner));
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'notes:files-updated' });
  }));
});

async function fileResponse(request) {
  const owner = await currentUser();
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (owner && response.ok && response.status === 200 && response.headers.get('x-notes-user') === owner && response.headers.has('content-length')) {
      await serializeFileCache(async () => {
        if (await currentUser() !== owner) return;
        const budget = await fileBudget(owner), size = Number(response.headers.get('content-length'));
        if (!Number.isFinite(size) || size < 0 || size > budget) return;
        const cache = await caches.open(FILE_PREFIX + owner);
        await cache.delete(request);
        await trimFiles(cache, budget - size);
        await cache.put(request, response.clone());
      }).catch(() => {});
    }
    // An explicit 401/404 must never fall back to a cached private file.
    return response;
  } catch {
    if (owner && await currentUser() === owner) {
      const cached = await (await caches.open(FILE_PREFIX + owner)).match(request);
      if (cached) return cached;
    }
    return new Response('此附件尚未下載至此裝置，請連線後再開啟。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/files/')) { event.respondWith(fileResponse(request)); return; }
  // Authentication and JSON data always go to the API, never to the shared shell cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(SHELL)).match('/')) ?? Response.error()));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
