import { readLocal, updateLocal } from './storage.ts';

export const DEFAULT_CACHE_MB = 500;
export const MAX_CACHE_MB = 10_000;
interface CacheSettings { limitBytes: number }

export async function attachmentCacheInfo() {
  const owner = await readLocal<{ id: string }>('user');
  if (!owner) throw new Error('請先登入。');
  const settings = await readLocal<CacheSettings>(`attachments:${owner.id}`);
  let usedBytes = 0, count = 0;
  if ('caches' in window) {
    const cache = await caches.open(`notes-files-${owner.id}`);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      usedBytes += Number(response?.headers.get('content-length')) || 0;
      count++;
    }
  }
  return { limitMB: (settings?.limitBytes ?? DEFAULT_CACHE_MB * 1024 * 1024) / 1024 / 1024, usedBytes, count };
}

export async function setAttachmentCacheLimit(limitMB: number): Promise<void> {
  if (!Number.isInteger(limitMB) || limitMB < 100 || limitMB > MAX_CACHE_MB) throw new Error(`請輸入 100 至 ${MAX_CACHE_MB} MB 的整數。`);
  const owner = await readLocal<{ id: string }>('user');
  if (!owner) throw new Error('請先登入。');
  await updateLocal<CacheSettings>(`attachments:${owner.id}`, () => ({ limitBytes: limitMB * 1024 * 1024 }));
  if ('serviceWorker' in navigator) navigator.serviceWorker.controller?.postMessage({ type: 'notes:trim-files' });
}
