import type { Migration } from '../migrate.ts';

export const migration: Migration = {
  id: '0006_database_views',
  up: `
    CREATE TABLE db_views_next (
      id TEXT PRIMARY KEY,
      database_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('table', 'list', 'board')),
      config TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO db_views_next SELECT id, database_id, name, type, config, position, created_at FROM db_views;
    DROP TABLE db_views;
    ALTER TABLE db_views_next RENAME TO db_views;
  `,
};
