import type { Migration } from '../migrate.ts';

/** Which queued operations (database, discussion) a server has already carried out, so a repeat changes nothing. */
export const migration: Migration = {
  id: '0008_offline_receipts',
  up: `CREATE TABLE IF NOT EXISTS offline_receipts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  );
  CREATE INDEX IF NOT EXISTS offline_receipts_created ON offline_receipts(created_at);`,
};
