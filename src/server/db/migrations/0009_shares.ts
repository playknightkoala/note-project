import type { Migration } from '../migrate.ts';

/**
 * Sharing. A page has at most one share: a scope, an optional public link and a list of member accounts.
 * `author_id`, `uploaded_by`, `content_by` and `written_by` record who acted on an owner's page; NULL means the owner.
 * A `floating` discussion was started by someone who may not write the page: its text carries no mark, readers find
 * the commented text by the quote instead.
 * The link token is kept readable so the owner can copy the address again: it grants read access to content
 * that is stored next to it in this same database.
 */
export const migration: Migration = {
  id: '0009_shares',
  up: `CREATE TABLE IF NOT EXISTS page_shares (
    page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'page' CHECK (scope IN ('page', 'subpages', 'all')),
    link_token TEXT UNIQUE,
    link_created_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS page_shares_user ON page_shares(user_id);
  CREATE TABLE IF NOT EXISTS share_members (
    page_id TEXT NOT NULL REFERENCES page_shares(page_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS share_members_user ON share_members(user_id);
  ALTER TABLE page_annotations ADD COLUMN author_id TEXT;
  ALTER TABLE files ADD COLUMN uploaded_by TEXT;
  ALTER TABLE page_annotations ADD COLUMN floating INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pages ADD COLUMN content_by TEXT;
  ALTER TABLE page_versions ADD COLUMN written_by TEXT;`,
};
