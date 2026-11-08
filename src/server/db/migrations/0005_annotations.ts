export const migration = {
  id: '0005_annotations',
  up: `
CREATE TABLE page_annotations (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  block_ids TEXT NOT NULL,
  messages TEXT NOT NULL,
  reactions TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX page_annotations_page ON page_annotations(user_id, page_id, created_at);
`,
};
