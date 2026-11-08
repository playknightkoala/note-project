import { api } from './client.ts';

export interface UploadedFile { id: string; url: string; name: string; mime: string; size: number; sha256: string; createdAt: number }

/** Multipart upload; the returned URL is same-origin and cookie-authenticated, so `<img>` and `<video>` can use it directly. */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  return api<UploadedFile>('POST', '/api/files', { form });
}
