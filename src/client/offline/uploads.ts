import { extensionFor, fileHeaders, fileUrlFor, sanitizeName, SNIFF_BYTES, sniffMime } from '@shared/files';
import { api } from '../api/client.ts';
import type { UploadedFile } from '../api/files.ts';
import { askAboutFixedText, fixedTextIsStale } from './fixedText.ts';
import type { FixedTextNote } from './fixedText.ts';
import { fileCache, offlineOwner, pageKey, uploadCache, uploadKey, uploadPrefix } from './owner.ts';
import { attachmentLimitBytes } from './attachments.ts';
import { mustStop, onlyHere } from './outbox.ts';
import { listLocal, updateLocal } from './storage.ts';

/** A file added while the server could not be reached. Its bytes wait in the browser's cache storage. */
export interface PendingUpload { id: string; userId: string; name: string; type: string; size: number; url: string; createdAt: number; problem?: string; /** The shared page it was added to, when that is somebody else's. */ pageId?: string }

export const pendingUploads = async (userId = offlineOwner()): Promise<PendingUpload[]> => userId ? listLocal<PendingUpload>(uploadPrefix(userId)) : [];
/**
 * A file added to a row that this device made in somebody else's database: the server checks the row, so the file
 * waits until the row exists there. It is not a failure, and it goes out by itself once the row has been created.
 */
const waitsForRow = async (userId: string, item: Pick<PendingUpload, 'pageId'>): Promise<boolean> => !!item.pageId && await onlyHere(userId, item.pageId);
/** Whether a file for this page has to be kept on the device for now, even with the server in reach. */
export const mustWaitForPage = async (pageId: string | undefined): Promise<boolean> => { const owner = offlineOwner(); return !!owner && await waitsForRow(owner, { pageId }); };
/** The waiting files a sync can send now. */
export async function sendableUploads(userId: string): Promise<PendingUpload[]> {
  const ready: PendingUpload[] = [];
  for (const item of await pendingUploads(userId)) if (!item.problem && !await waitsForRow(userId, item)) ready.push(item);
  return ready;
}

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
  let moved = false;
  try {
    for (const item of await sendableUploads(userId)) {
      if (offlineOwner() !== userId) return;
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
      // A file larger than the whole attachment space allowed on this device is not kept, as with a download:
      // keeping it would push out everything else before being dropped itself.
      if (item.size <= await attachmentLimitBytes(userId)) {
        await (await caches.open(fileCache(userId))).put(item.url, stored).catch(() => {});
        moved = true;
      }
      await cache.delete(item.url).catch(() => {});
      await updateLocal<PendingUpload>(key, () => undefined);
    }
  } finally {
    // What was just moved counts towards the attachment space the user allows on this device, like any download:
    // the offline interface drops the oldest kept files beyond it. Best effort: it must never fail the sync.
    if (moved) try { navigator.serviceWorker?.controller?.postMessage({ type: 'notes:trim-files' }); } catch { /* trimmed at the next download */ }
  }
}

export async function retryUpload(item: PendingUpload): Promise<void> {
  await updateLocal<PendingUpload>(uploadKey(item.userId, item.id), current => current && { ...current, problem: undefined });
}
/**
 * Removes the waiting file from this device. A note that refers to it will show a missing attachment. Where the
 * file was already taken out of a note's draft but a text fixed earlier for sending still shows it, that text is
 * not sent with the dead address: the user is asked first (see `fixedText.ts`). Done before the file's record goes,
 * so a sync in between finds either the record or the question.
 */
export async function discardUpload(item: PendingUpload): Promise<void> {
  for (const note of await listLocal<FixedTextNote & { local: { page: { id: string } } }>(`page:${item.userId}:`).catch(() => [])) {
    if (!fixedTextIsStale(note, [item.url])) continue;
    await updateLocal<FixedTextNote>(pageKey(item.userId, note.local.page.id), current => current && !current.problem && fixedTextIsStale(current, [item.url]) ? askAboutFixedText(current) : current);
  }
  if ('caches' in window) await (await caches.open(uploadCache(item.userId))).delete(item.url).catch(() => {});
  await updateLocal<PendingUpload>(uploadKey(item.userId, item.id), () => undefined);
}
