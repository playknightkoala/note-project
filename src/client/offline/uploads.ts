import { extensionFor, fileHeaders, fileUrlFor, sanitizeName, SNIFF_BYTES, sniffMime } from '@shared/files';
import { api } from '../api/client.ts';
import type { UploadedFile } from '../api/files.ts';
import { fileCache, offlineOwner, uploadCache, uploadKey } from './owner.ts';
import { mustStop } from './outbox.ts';
import { listLocal, updateLocal } from './storage.ts';

/** A file added while the server could not be reached. Its bytes wait in the browser's cache storage. */
export interface PendingUpload { id: string; userId: string; name: string; type: string; size: number; url: string; createdAt: number; problem?: string; /** The shared page it was added to, when that is somebody else's. */ pageId?: string }

export const pendingUploads = async (userId = offlineOwner()): Promise<PendingUpload[]> => userId ? listLocal<PendingUpload>(`upload:${userId}:`) : [];

/**
 * Keeps a file on this device under the address it will have on the server, so the note can refer to it right away.
 * The offline interface (service worker) answers that address from here until the file has been uploaded.
 */
export async function queueUpload(file: File, id: string, maxBytes?: number, pageId?: string): Promise<UploadedFile> {
  const owner = offlineOwner();
  if (!owner) throw new Error('請先登入。');
  if (!('caches' in window) || !navigator.serviceWorker?.controller) throw new Error('此裝置尚未啟用離線介面，無法離線加入附件；請連線後再試。');
  if (file.size === 0) throw new Error('檔案是空的。');
  if (maxBytes && file.size > maxBytes) throw new Error(`檔案超過 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  // Decided the same way the server will: only real images are shown inline, everything else is a sandboxed download.
  const mime = sniffMime(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()), file.type || undefined);
  const name = sanitizeName(file.name, extensionFor(mime)), url = fileUrlFor(id, name);
  const headers = { ...fileHeaders(mime, name), 'Content-Length': String(file.size), 'Cache-Control': 'no-store', 'X-Notes-User': owner, 'X-Notes-Pending': '1' };
  try { await (await caches.open(uploadCache(owner))).put(url, new Response(file, { headers })); }
  catch { throw new Error('無法將附件保存至此裝置，可能儲存空間不足。'); }
  const item: PendingUpload = { id, userId: owner, name, type: file.type, size: file.size, url, createdAt: Date.now(), ...(pageId ? { pageId } : {}) };
  const undo = () => caches.open(uploadCache(owner)).then(cache => cache.delete(url)).catch(() => {});
  // Ask for it the way the note will. An offline interface from before this feature does not answer from here yet,
  // and the note would then show a broken attachment until it is updated.
  const shown = await fetch(url, { credentials: 'same-origin' }).then(response => { void response.body?.cancel().catch(() => {}); return response.ok; }, () => false);
  if (!shown) { await undo(); throw new Error('此裝置的離線介面需要更新後才能離線加入附件；請連線重新載入後再試。'); }
  try { await updateLocal<PendingUpload>(uploadKey(owner, id), () => item); }
  catch (error) { await undo(); throw error; }
  return { id, url, name, mime, size: file.size, sha256: '', createdAt: item.createdAt, queued: true };
}

/**
 * Uploads the waiting files. The server keeps each under the id chosen here, so a repeat after a lost answer is
 * harmless. Afterwards the bytes move to the ordinary attachment cache and stay readable offline.
 */
export async function sendUploads(userId: string): Promise<void> {
  for (const item of await pendingUploads(userId)) {
    if (offlineOwner() !== userId) return;
    if (item.problem) continue;
    const key = uploadKey(userId, item.id);
    const fail = (problem: string) => updateLocal<PendingUpload>(key, current => current && { ...current, problem });
    if (!('caches' in window)) { await fail('此瀏覽器無法讀取待上傳的附件。'); continue; }
    const cache = await caches.open(uploadCache(userId));
    const stored = await cache.match(item.url);
    if (!stored) { await fail('此裝置上的附件內容已遺失（可能已被瀏覽器清除），無法上傳。'); continue; }
    const form = new FormData();
    form.append('file', new File([await stored.clone().blob()], item.name, { type: item.type }));
    form.append('id', item.id);
    if (item.pageId) form.append('pageId', item.pageId);
    try { await api<UploadedFile>('POST', '/api/files', { form }); }
    catch (error) {
      if (mustStop(error)) throw error;
      await fail(error instanceof Error ? error.message : '上傳失敗');
      continue;
    }
    await (await caches.open(fileCache(userId))).put(item.url, stored).catch(() => {});
    await cache.delete(item.url).catch(() => {});
    await updateLocal<PendingUpload>(key, () => undefined);
  }
}

export async function retryUpload(item: PendingUpload): Promise<void> {
  await updateLocal<PendingUpload>(uploadKey(item.userId, item.id), current => current && { ...current, problem: undefined });
}
/** Removes the waiting file from this device. A note that refers to it will show a missing attachment. */
export async function discardUpload(item: PendingUpload): Promise<void> {
  if ('caches' in window) await (await caches.open(uploadCache(item.userId))).delete(item.url).catch(() => {});
  await updateLocal<PendingUpload>(uploadKey(item.userId, item.id), () => undefined);
}
