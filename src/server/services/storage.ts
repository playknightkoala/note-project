import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/driver.ts';
import { AppError } from '../../shared/errors.ts';
import { extensionFor, fileUrlFor, sanitizeName, sniffMime } from '../../shared/files.ts';

export { sniffMime };

export interface FileRow { id: string; user_id: string; sha256: string; size: number; mime: string; original_name: string; ext: string; import_key: string | null; created_at: number }
export interface FileDto { id: string; url: string; name: string; mime: string; size: number; sha256: string; createdAt: number }

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

export const fileDto = (row: FileRow): FileDto => ({ id: row.id, url: fileUrlFor(row.id, row.original_name), name: row.original_name, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at });

export interface SaveFileInput { bytes: Uint8Array; originalName: string; declaredMime: string | undefined; importKey?: string | null; /** Chosen by the client so an upload can be retried safely. */ id?: string }

/** Returns `created: false` when the client-chosen id is already this user's file, i.e. an earlier attempt got through. */
export function saveFile(db: Db, dataDir: string, userId: string, input: SaveFileInput, now: number): FileRow & { created: boolean } {
  if (input.bytes.byteLength === 0) throw new AppError('bad_request', '檔案是空的。');
  if (input.id) {
    const existing = db.get<FileRow>('SELECT * FROM files WHERE id = ?', input.id);
    if (existing) {
      // Another account's id is reported exactly like any other unusable id.
      if (existing.user_id !== userId) throw new AppError('conflict', '檔案識別碼無法使用，請重新上傳。');
      return { ...existing, created: false };
    }
  }
  const mime = sniffMime(input.bytes, input.declaredMime);
  const ext = extensionFor(mime);
  const sha256 = storeBlob(dataDir, input.bytes);
  const row: FileRow = { id: input.id ?? crypto.randomUUID(), user_id: userId, sha256, size: input.bytes.byteLength, mime, original_name: sanitizeName(input.originalName, ext), ext, import_key: input.importKey ?? null, created_at: now };
  db.run('INSERT INTO files (id, user_id, sha256, size, mime, original_name, ext, import_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id, row.user_id, row.sha256, row.size, row.mime, row.original_name, row.ext, row.import_key, row.created_at);
  return { ...row, created: true };
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
