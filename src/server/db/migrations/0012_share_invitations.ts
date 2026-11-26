import type { Migration } from '../migrate.ts';

export const migration: Migration = {
  id: '0012_share_invitations',
  up: `CREATE TABLE IF NOT EXISTS share_invitations (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES page_shares(page_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    UNIQUE (page_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS share_invitations_user ON share_invitations(user_id);`,
};
