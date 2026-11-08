// Thin adapter over node:sqlite so the rest of the server never touches the driver directly.
// Swapping to better-sqlite3 means re-implementing only this file.
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type Param = SQLInputValue;
export type Row = Record<string, SQLOutputValue>;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  all<T = Row>(sql: string, ...params: Param[]): T[];
  /** BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
  backup(destination: string): Promise<void>;
  close(): void;
}

export function openDatabase(file: string): Db {
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('PRAGMA busy_timeout=5000');
  let depth = 0;
  const prepare = (sql: string) => database.prepare(sql);
  const db: Db = {
    exec: sql => database.exec(sql),
    run: (sql, ...params) => {
      const result = prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get: (sql, ...params) => prepare(sql).get(...params) as never,
    all: (sql, ...params) => prepare(sql).all(...params) as never,
    transaction: fn => {
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      database.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const result = fn();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* connection already failed */ }
        throw error;
      } finally { depth = 0; }
    },
    backup: async destination => { await sqliteBackup(database, destination); },
    close: () => database.close(),
  };
  return db;
}

/** Startup self-check: the bundled SQLite must have FTS5 and be new enough for the trigram tokenizer (3.34). */
export function assertSqliteCapabilities(db: Db): { version: string } {
  const version = String(db.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? '');
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 34)) throw new Error(`SQLite ${version} 太舊，需要 3.34 以上。`);
  const options = db.all<{ compile_options: string }>('PRAGMA compile_options').map(row => row.compile_options);
  if (!options.includes('ENABLE_FTS5')) throw new Error('此 Node 的 SQLite 沒有 FTS5，無法啟動。');
  return { version };
}
