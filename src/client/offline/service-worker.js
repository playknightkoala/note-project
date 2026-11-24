/* The build replaces these constants with a versioned shell and its complete asset list. */
const SHELL = '__NOTES_SHELL__';
const VERSION = '__NOTES_VERSION__';
const ASSETS = /* __NOTES_ASSETS__ */ [];
const clientVersions = new Map();
const FILE_PREFIX = 'notes-files-';
/** Files added offline wait here, under their final address, until the page has uploaded them. Never trimmed. */
const UPLOAD_PREFIX = 'notes-uploads-';
const DEFAULT_FILE_BUDGET = 500 * 1024 * 1024;
const NAVIGATION_WAIT_MS = 800;
let fileCacheTask = Promise.resolve();
function serializeFileCache(task) {
  const result = fileCacheTask.then(task);
  fileCacheTask = result.catch(() => {});
  return result;
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS)));
  // Activate after old tabs close, or after the user explicitly requests an update.
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Self-heal: if anything removed part of this shell while the worker was waiting, fetch it again now.
    try {
      const cache = await caches.open(SHELL), missing = [];
      for (const asset of ASSETS) if (!await cache.match(asset)) missing.push(asset);
      if (missing.length) await cache.addAll(missing);
    } catch { /* offline: the next activation or asset request fills it in */ }
    await self.clients.claim();
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'notes:report-version' });
  })());
});

async function cleanupShells() {
  // Only the newest worker may delete shells. While a newer one is installing or waiting, its shell is in the cache
  // list too, and this (older) worker cannot tell it from a leftover.
  if (self.registration?.installing || self.registration?.waiting) return;
  const clients = await self.clients.matchAll();
  // Unknown/old tabs retain their assets so an update in another tab cannot break their editor.
  if (clients.some(client => clientVersions.get(client.id) !== VERSION)) return;
  for (const key of await caches.keys()) if (key.startsWith('notes-shell-') && key !== SHELL) await caches.delete(key);
}

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
  if (event.data?.type === 'notes:get-version') {
    event.ports?.[0]?.postMessage({ version: VERSION });
    return;
  }
  if (event.data?.type === 'notes:activate-update' && event.data.version === VERSION) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === 'notes:client-version' && event.source?.id) {
    clientVersions.set(event.source.id, event.data.version);
    event.waitUntil(cleanupShells());
    return;
  }
  if (event.data?.type !== 'notes:trim-files') return;
  event.waitUntil(serializeFileCache(async () => {
    const owner = await currentUser();
    if (owner) await trimFiles(await caches.open(FILE_PREFIX + owner), await fileBudget(owner));
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'notes:files-updated' });
  }));
});

/** Keeps a copy for offline use. Runs after the response has been handed to the page, never in front of it. */
async function storeFile(owner, request, response) {
  let stored = false;
  try {
    if (await currentUser() !== owner) return;
    const budget = await fileBudget(owner), size = Number(response.headers.get('content-length'));
    if (!Number.isFinite(size) || size < 0 || size > budget) return;
    const cache = await caches.open(FILE_PREFIX + owner);
    // Attachments are content-addressed: the same ETag is the same bytes, already on this device.
    const etag = response.headers.get('etag');
    if (etag && (await cache.match(request))?.headers.get('etag') === etag) return;
    await cache.put(request, response);
    stored = true;
    // Only the eviction pass is serialized; downloads themselves run side by side.
    await serializeFileCache(async () => {
      if (await currentUser() !== owner) { await caches.delete(FILE_PREFIX + owner); return; }
      await trimFiles(cache, budget);
    });
  } catch { /* caching is best effort */ }
  // Release the unused copy so it is not buffered. Not awaited: cancelling one half of a cloned body only settles
  // once the other half (the page's) has finished too.
  finally { if (!stored) void response.body?.cancel().catch(() => {}); }
}

/** The signed-in account's own file that has not reached the server yet. The page stored it with download-safe headers. */
async function pendingUpload(owner, request) {
  if (!owner) return undefined;
  const cached = await caches.match(request.url, { cacheName: UPLOAD_PREFIX + owner });
  return cached && await currentUser() === owner ? cached : undefined;
}

async function fileResponse(event) {
  const request = event.request;
  const owner = await currentUser();
  const pending = await pendingUpload(owner, request).catch(() => undefined);
  // Newly added files should remain available even when the connection hangs. Previously downloaded files
  // still wait for the server to answer, and a definite denial always takes precedence.
  const timeout = pending ? new AbortController() : undefined;
  const timer = timeout && setTimeout(() => timeout.abort(), 3_000);
  try {
    // The browser's HTTP cache may revalidate with the ETag (304), so an unchanged file is not downloaded again.
    const response = timeout ? await fetch(request, { signal: timeout.signal }) : await fetch(request);
    // The server does not know a file that is still waiting on this device; that is the only 404 answered locally.
    if (owner && (response.status === 401 || response.status === 403 || response.status === 404)) {
      const remove = caches.open(FILE_PREFIX + owner).then(cache => cache.delete(request)).catch(() => {});
      if (event.waitUntil) event.waitUntil(remove);
    }
    if (response.status === 404) return await pendingUpload(owner, request).catch(() => undefined) ?? response;
    if (owner && response.ok && response.status === 200 && response.headers.get('x-notes-user') === owner && response.headers.has('content-length')) {
      const work = storeFile(owner, request, response.clone());
      if (event.waitUntil) event.waitUntil(work);
    }
    // An explicit denial must never fall back to a downloaded private file.
    return response;
  } catch {
    if (owner && await currentUser() === owner) {
      const cached = timeout?.signal.aborted ? await pendingUpload(owner, request)
        : await (await caches.open(FILE_PREFIX + owner)).match(request) ?? await pendingUpload(owner, request);
      if (cached) return cached;
    }
    return new Response('此附件尚未下載至此裝置，請連線後再開啟。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function navigationResponse(request, isPublic) {
  const network = fetch(request).catch(() => undefined);
  const shell = () => caches.open(SHELL).then(cache => cache.match('/')).catch(() => undefined);
  if (isPublic) return await network ?? await shell() ?? Response.error();
  const cached = await shell();
  if (!cached) return await network ?? Response.error();
  // Prefer a fresh shell when the server answers quickly, including when it has newer security headers.
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, NAVIGATION_WAIT_MS); });
  try { return await Promise.race([network, deadline]) ?? cached; }
  finally { clearTimeout(timer); }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/files/')) { event.respondWith(fileResponse(event)); return; }
  // Authentication and JSON data always go to the API, never to the shared shell cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request, url.pathname.startsWith('/s/')));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      if (cached) return cached;
      for (const name of await caches.keys()) {
        if (!name.startsWith('notes-shell-') || name === SHELL) continue;
        const previous = await (await caches.open(name)).match(request);
        if (previous) return previous;
      }
      const response = await fetch(request);
      // Never store an HTML answer (an error page or an app-shell fallback) under an asset's name.
      if (response.ok && !(response.headers.get('content-type') ?? '').includes('text/html')) await cache.put(request, response.clone());
      return response;
    })());
  }
});
