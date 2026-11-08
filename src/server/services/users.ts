import type { Db } from '../db/driver.ts';
import type { UserRow } from '../auth/session.ts';
import type { AdminUserDto } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';

export function countUsers(db: Db): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
}

export function findUserByIdentifier(db: Db, identifier: string): UserRow | undefined {
  const value = identifier.trim().toLowerCase();
  return db.get<UserRow>('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1', value, value);
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function insertUser(db: Db, input: { email: string; username: string | null; displayName: string; passwordHash: string; role: 'admin' | 'user' }, now: number): UserRow {
  const row: UserRow = { id: crypto.randomUUID(), email: input.email, username: input.username, display_name: input.displayName,
    password_hash: input.passwordHash, role: input.role, disabled_at: null, created_at: now, updated_at: now };
  try {
    db.run('INSERT INTO users (id, email, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.email, row.username, row.display_name, row.password_hash, row.role, row.created_at, row.updated_at);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new AppError('conflict', '電子郵件或使用者名稱已被使用。');
    throw error;
  }
  return row;
}

export function listUsersForAdmin(db: Db): AdminUserDto[] {
  return db.all<UserRow & { page_count: number }>(
    'SELECT u.*, (SELECT COUNT(*) FROM pages p WHERE p.user_id = u.id AND p.trashed_at IS NULL) AS page_count FROM users u ORDER BY u.created_at',
  ).map(row => ({ id: row.id, email: row.email, username: row.username, displayName: row.display_name, role: row.role,
    createdAt: row.created_at, disabledAt: row.disabled_at, pageCount: Number(row.page_count) }));
}

export function countActiveAdmins(db: Db): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL")?.n ?? 0);
}
