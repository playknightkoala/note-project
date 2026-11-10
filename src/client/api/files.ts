import { newId } from '@shared/ids';
import { api } from './client.ts';
import { transient } from '../offline/outbox.ts';
import { queueUpload } from '../offline/uploads.ts';
import { syncStatus } from '../offline/notes.ts';

export interface UploadedFile { id: string; url: string; name: string; mime: string; size: number; sha256: string; createdAt: number; /** Kept on this device; uploaded at the next sync. */ queued?: boolean }
export let pendingFileUploads = 0;

/**
 * Multipart upload; the returned URL is same-origin and cookie-authenticated, so `<img>` and `<video>` can use it
 * directly. The id is chosen here, which lets a failed attempt be repeated without storing the file twice. With
 * `offline`, a file that cannot reach the server is kept on this device and uploaded later (attachments in a note);
 * without it the caller needs the file on the server now (a cover).
 */
export async function uploadFile(file: File, { offline = false, pageId }: { offline?: boolean; /** Somebody else's page the file is added to: it becomes that page owner's file. */ pageId?: string } = {}): Promise<UploadedFile> {
  const id = newId();
  pendingFileUploads++;
  try {
    if (navigator.onLine !== false || !offline) {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('id', id);
      if (pageId) form.append('pageId', pageId);
      try { return await api<UploadedFile>('POST', '/api/files', { form }); }
      catch (error) { if (!offline || !transient(error)) throw error; }
    }
    return await queueUpload(file, id, syncStatus.maxUploadBytes, pageId);
  }
  finally { pendingFileUploads--; }
}
