import type { Db } from './driver.ts';
import { migration as init } from './migrations/0001_init.ts';
import { migration as coverPreset } from './migrations/0002_cover_preset.ts';
import { migration as searchContent } from './migrations/0003_search_content.ts';

export interface Migration { id: string; up: string }
export const migrations: Migration[] = [init, coverPreset, searchContent];

/** Applies every migration whose id is not yet recorded, each in its own immediate transaction. Idempotent. */
export function migrate(db: Db, list: Migration[] = migrations): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.all<{ id: string }>('SELECT id FROM schema_migrations').map(row => row.id));
  const ran: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', migration.id, Date.now());
    });
    ran.push(migration.id);
  }
  return ran;
}
