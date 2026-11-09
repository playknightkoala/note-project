/* The build replaces these constants with a versioned shell and its complete asset list. */
const SHELL = '__NOTES_SHELL__';
const ASSETS = /* __NOTES_ASSETS__ */ [];
const FILE_PREFIX = 'notes-files-';

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

async function currentUser() {
  return new Promise(resolve => {
    const request = indexedDB.open('notes-offline-v1', 1);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) { db.close(); resolve(null); return; }
      const read = db.transaction('records').objectStore('records').get('user');
      read.onsuccess = () => { db.close(); resolve(read.result?.id ?? null); };
      read.onerror = () => { db.close(); resolve(null); };
    };
  });
}

async function fileResponse(request) {
  const owner = await currentUser();
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (owner && response.ok && response.headers.get('x-notes-user') === owner && await currentUser() === owner && Number(response.headers.get('content-length')) <= 20 * 1024 * 1024) {
      const cache = await caches.open(FILE_PREFIX + owner);
      await cache.put(request, response.clone()).catch(() => {});
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - 100))) await cache.delete(key);
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
