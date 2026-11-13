import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/driver.ts';
import { AppError } from '../../shared/errors.ts';
import { extensionFor, fileUrlFor, sanitizeName, sniffMime } from '../../shared/files.ts';
import type { ShareScope } from '../../shared/shares.ts';
import { scopeShowsFile } from './access.ts';
import type { LinkShare } from './access.ts';

export { sniffMime };

export interface FileRow { id: string; user_id: string; sha256: string; size: number; mime: string; original_name: string; ext: string; import_key: string | null; created_at: number; /** The member who added it to the owner's page; null when the owner did. */ uploaded_by?: string | null }
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

export interface SaveFileInput { bytes: Uint8Array; originalName: string; declaredMime: string | undefined; importKey?: string | null; /** Chosen by the client so an upload can be retried safely. */ id?: string; /** A member adding a file to the page of `userId`. */ uploadedBy?: string | undefined }

/**
 * Returns `created: false` when the client-chosen id is already this user's file, i.e. an earlier attempt got through.
 * `quotaBytes` (0: none) caps what one account's files add up to; a member's upload counts towards the page owner's.
 */
export function saveFile(db: Db, dataDir: string, userId: string, input: SaveFileInput, now: number, quotaBytes = 0): FileRow & { created: boolean } {
  if (input.bytes.byteLength === 0) throw new AppError('bad_request', '檔案是空的。');
  if (input.id) {
    const existing = db.get<FileRow>('SELECT * FROM files WHERE id = ?', input.id);
    if (existing) {
      // Another account's id is reported exactly like any other unusable id.
      // So is an owner's file that somebody else sends an id for: nothing about it is given away.
      if (existing.user_id !== userId || (existing.uploaded_by ?? null) !== (input.uploadedBy ?? null)) throw new AppError('conflict', '檔案識別碼無法使用，請重新上傳。');
      return { ...existing, created: false };
    }
  }
  if (quotaBytes > 0) {
    const used = Number(db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?', userId)?.n ?? 0);
    if (used + input.bytes.byteLength > quotaBytes) throw new AppError('payload_too_large', `附件空間已達上限（${Math.round(quotaBytes / 1024 / 1024)} MB），無法再加入檔案。`);
  }
  const mime = sniffMime(input.bytes, input.declaredMime);
  const ext = extensionFor(mime);
  const sha256 = storeBlob(dataDir, input.bytes);
  const row: FileRow = { id: input.id ?? crypto.randomUUID(), user_id: userId, sha256, size: input.bytes.byteLength, mime, original_name: sanitizeName(input.originalName, ext), ext, import_key: input.importKey ?? null, created_at: now, uploaded_by: input.uploadedBy ?? null };
  db.run('INSERT INTO files (id, user_id, sha256, size, mime, original_name, ext, import_key, created_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id, row.user_id, row.sha256, row.size, row.mime, row.original_name, row.ext, row.import_key, row.created_at, row.uploaded_by ?? null);
  return { ...row, created: true };
}

export function loadFile(db: Db, userId: string, id: string): FileRow {
  const row = db.get<FileRow>('SELECT * FROM files WHERE id = ? AND user_id = ?', id, userId);
  if (!row) throw new AppError('not_found', '找不到檔案。');
  return row;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = () => new AppError('not_found', '找不到檔案。');

/**
 * A file as somebody may read it: their own, one they added to another person's page, or one that a page shared
 * with them shows (as its cover or in its content). "Shared with them" means a share that lists them, or one whose
 * link gives accounts a role and which they have opened. Anything else is "not found".
 */
export function loadFileFor(db: Db, viewerId: string, id: string): FileRow {
  const row = db.get<FileRow>('SELECT * FROM files WHERE id = ?', id);
  if (!row) throw missing();
  if (row.user_id === viewerId || row.uploaded_by === viewerId) return row;
  if (!FILE_ID.test(id)) throw missing();
  const shares = db.all<{ page_id: string; scope: ShareScope }>(
    `SELECT s.page_id, s.scope FROM page_shares s JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
     WHERE s.user_id = ? AND (EXISTS(SELECT 1 FROM share_members m WHERE m.page_id = s.page_id AND m.user_id = ?)
       OR (s.account_role IS NOT NULL AND EXISTS(SELECT 1 FROM share_visitors v WHERE v.page_id = s.page_id AND v.user_id = ?)))`, row.user_id, viewerId, viewerId);
  if (!shares.some(share => scopeShowsFile(db, row.user_id, share.page_id, share.scope, id))) throw missing();
  return row;
}

/** A file for the visitor of a public link: only what a page the link reaches shows. */
export function loadLinkFile(db: Db, link: LinkShare, id: string): FileRow {
  const row = FILE_ID.test(id) ? db.get<FileRow>('SELECT * FROM files WHERE id = ? AND user_id = ?', id, link.ownerId) : undefined;
  if (!row || !scopeShowsFile(db, link.ownerId, link.pageId, link.scope, id)) throw missing();
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
