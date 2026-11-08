import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import type { UserDto } from '../../shared/api.ts';

export const SESSION_COOKIE = 'sid';
export const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SLIDE_INTERVAL_MS = 60 * 60 * 1000;

export interface UserRow {
  id: string; email: string; username: string | null; display_name: string; password_hash: string;
  role: 'admin' | 'user'; disabled_at: number | null; created_at: number; updated_at: number;
}
export interface SessionRow { id: string; user_id: string; csrf_token: string; created_at: number; last_seen_at: number; expires_at: number }
export interface AuthContext { user: UserRow; session: SessionRow }

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const userDto = (user: UserRow): UserDto => ({
  id: user.id, email: user.email, username: user.username, displayName: user.display_name, role: user.role, createdAt: user.created_at,
});

export function createSession(db: Db, userId: string, now: number, meta: { userAgent?: string | undefined; ip?: string | undefined } = {}): { token: string; csrfToken: string } {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    hashToken(token), userId, csrfToken, now, now, now + IDLE_TTL_MS, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null);
  return { token, csrfToken };
}

/** Resolves a cookie token to its user; slides the idle expiry at most once per hour. Expired or disabled → null. */
export function loadSession(db: Db, token: string | undefined, now: number): AuthContext | null {
  if (!token || token.length > 200) return null;
  const session = db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', hashToken(token));
  if (!session) return null;
  if (session.expires_at <= now || session.created_at + ABSOLUTE_TTL_MS <= now) { db.run('DELETE FROM sessions WHERE id = ?', session.id); return null; }
  const user = db.get<UserRow>('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user) return null;
  if (now - session.last_seen_at > SLIDE_INTERVAL_MS) {
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, now + IDLE_TTL_MS, session.id);
    session.last_seen_at = now; session.expires_at = now + IDLE_TTL_MS;
  }
  return { user, session };
}

export function deleteSession(db: Db, token: string): void { db.run('DELETE FROM sessions WHERE id = ?', hashToken(token)); }
export function deleteUserSessions(db: Db, userId: string, exceptToken?: string): void {
  if (exceptToken) db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, hashToken(exceptToken));
  else db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}
export function sweepSessions(db: Db, now: number): number {
  return db.run('DELETE FROM sessions WHERE expires_at <= ? OR created_at + ? <= ?', now, ABSOLUTE_TTL_MS, now).changes;
}
