import { randomBytes } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import type { InviteDto } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';
import { hashToken } from './session.ts';

interface InviteRow {
  id: string; code_hash: string; created_by: string; created_at: number; expires_at: number;
  used_by: string | null; used_at: number | null; revoked_at: number | null; note: string | null;
}

const toDto = (row: InviteRow): InviteDto => ({
  id: row.id, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at, usedBy: row.used_by, revokedAt: row.revoked_at,
});

/** Returns the plain code exactly once; only its hash is stored. */
export function createInvite(db: Db, createdBy: string, now: number, expiresInHours: number, note?: string): { code: string; invite: InviteDto } {
  const code = randomBytes(18).toString('base64url');
  const row: InviteRow = { id: crypto.randomUUID(), code_hash: hashToken(code), created_by: createdBy, created_at: now,
    expires_at: now + expiresInHours * 3_600_000, used_by: null, used_at: null, revoked_at: null, note: note ?? null };
  db.run('INSERT INTO invites (id, code_hash, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?)',
    row.id, row.code_hash, row.created_by, row.created_at, row.expires_at, row.note);
  return { code, invite: toDto(row) };
}

/** True when the code names an unused, unrevoked, unexpired invite. Checked before any account data is touched. */
export function inviteUsable(db: Db, code: string, now: number): boolean {
  return db.get('SELECT 1 AS ok FROM invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', hashToken(code), now) !== undefined;
}

/** Consumes an invite inside the caller's transaction; throws `invite_invalid` when unusable. */
export function redeemInvite(db: Db, code: string, userId: string, now: number): void {
  const changed = db.run(
    'UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
    userId, now, hashToken(code), now).changes;
  if (changed !== 1) throw new AppError('invite_invalid');
}

export function listInvites(db: Db): InviteDto[] {
  return db.all<InviteRow>('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200').map(toDto);
}

export function revokeInvite(db: Db, id: string, now: number): boolean {
  return db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL', now, id).changes === 1;
}
