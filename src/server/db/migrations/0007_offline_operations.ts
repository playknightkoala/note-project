import type { Migration } from '../migrate.ts';

export const migration: Migration = {
  id: '0007_offline_operations',
  up: `CREATE TABLE IF NOT EXISTS offline_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    response TEXT NOT NULL,
    PRIMARY KEY (user_id, operation_id)
  );`,
};
