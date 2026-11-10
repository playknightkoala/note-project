import type { Migration } from '../migrate.ts';

/**
 * "Anyone signed in who has the link": a share may give every account of this site a role without listing it.
 * The link is the page's own address. An account that opened it is remembered in `share_visitors`, so the page
 * shows up under what is shared with them and is kept on their devices, for as long as the link access stays on.
 */
export const migration: Migration = {
  id: '0010_share_account_link',
  up: `ALTER TABLE page_shares ADD COLUMN account_role TEXT CHECK (account_role IN ('viewer', 'editor'));
  CREATE TABLE IF NOT EXISTS share_visitors (
    page_id TEXT NOT NULL REFERENCES page_shares(page_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS share_visitors_user ON share_visitors(user_id);`,
};
