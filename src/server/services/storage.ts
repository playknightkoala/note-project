import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/driver.ts';
import { AppError } from '../../shared/errors.ts';

export interface FileRow { id: string; user_id: string; sha256: string; size: number; mime: string; original_name: string; ext: string; import_key: string | null; created_at: number }
export interface FileDto { id: string; url: string; name: string; mime: string; size: number; sha256: string; createdAt: number }

/** MIME → extension for everything the server will store under its own name; anything else becomes an octet-stream attachment. */
const ALLOWED: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Magic-byte sniffing for the types browsers render inline; the declared type is only trusted when allow-listed. */
export function sniffMime(bytes: Uint8Array, declared: string | undefined): string {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  const ascii = (offset: number, text: string) => Buffer.from(bytes.subarray(offset, offset + text.length)).toString('latin1') === text;
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, '%PDF')) return 'application/pdf';
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(4, 'ftyp')) return declared === 'audio/mp4' ? 'audio/mp4' : 'video/mp4';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb) || starts(0xff, 0xf3)) return 'audio/mpeg';
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    if (declared && declared.startsWith('application/vnd.openxmlformats')) return ALLOWED[declared] ? declared : 'application/zip';
    return 'application/zip';
  }
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml' || type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf') {
    // Declared as media but the bytes do not match: never serve it inline.
    return type === 'image/svg+xml' ? 'image/svg+xml' : 'application/octet-stream';
  }
  return ALLOWED[type] ? type : 'application/octet-stream';
}

export const servesInline = (mime: string): boolean => INLINE.has(mime);
export const extensionFor = (mime: string): string => ALLOWED[mime] ?? 'bin';

export function sanitizeName(name: string, ext: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '').trim().slice(0, 200);
  const base = cleaned || `file.${ext}`;
  return base.includes('.') ? base : `${base}.${ext}`;
}

export const blobPath = (dataDir: string, sha256: string): string => join(dataDir, 'files', sha256.slice(0, 2), sha256.slice(2, 4), sha256);

/** Content-addressed write: temp file + rename; identical bytes are stored once. */
export function storeBlob(dataDir: string, bytes: Uint8Array): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const target = blobPath(dataDir, sha256);
  if (!existsSync(target)) {
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    mkdirSync(join(target, '..'), { recursive: true });
    const temp = join(dataDir, 'tmp', `${crypto.randomUUID()}.part`);
    writeFileSync(temp, bytes);
    try { renameSync(temp, target); } catch (error) { try { unlinkSync(temp); } catch { /* ignore */ } if (!existsSync(target)) throw error; }
  }
  return sha256;
}

export const fileDto = (row: FileRow): FileDto => ({ id: row.id, url: `/api/files/${row.id}/${encodeURIComponent(row.original_name)}`, name: row.original_name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at });

export interface SaveFileInput { bytes: Uint8Array; originalName: string; declaredMime: string | undefined; importKey?: string | null }

export function saveFile(db: Db, dataDir: string, userId: string, input: SaveFileInput, now: number): FileRow {
  if (input.bytes.byteLength === 0) throw new AppError('bad_request', '檔案是空的。');
  const mime = sniffMime(input.bytes, input.declaredMime);
  const ext = extensionFor(mime);
  const sha256 = storeBlob(dataDir, input.bytes);
  const row: FileRow = { id: crypto.randomUUID(), user_id: userId, sha256, size: input.bytes.byteLength, mime, original_name: sanitizeName(input.originalName, ext), ext, import_key: input.importKey ?? null, created_at: now };
  db.run('INSERT INTO files (id, user_id, sha256, size, mime, original_name, ext, import_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id, row.user_id, row.sha256, row.size, row.mime, row.original_name, row.ext, row.import_key, row.created_at);
  return row;
}

export function loadFile(db: Db, userId: string, id: string): FileRow {
  const row = db.get<FileRow>('SELECT * FROM files WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new AppError('not_found', '找不到檔案。');
  return row;
}

/** Removes the row; the blob is deleted only when no other row (any user) still references the same bytes. */
export function deleteFile(db: Db, dataDir: string, userId: string, id: string): void {
  const row = loadFile(db, userId, id);
  db.transaction(() => {
    db.run('DELETE FROM files WHERE id = ?', id);
    const others = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files WHERE sha256 = ?', row.sha256)?.n ?? 0);
    if (others === 0) { try { unlinkSync(blobPath(dataDir, row.sha256)); } catch { /* already gone */ } }
  });
}
