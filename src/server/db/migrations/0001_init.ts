export const migration = {
  id: '0001_init',
  up: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES users(id),
  used_at INTEGER,
  revoked_at INTEGER,
  note TEXT
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  original_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  import_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX files_user_sha ON files(user_id, sha256);
CREATE UNIQUE INDEX files_import_key ON files(user_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE pages (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','database','row')),
  database_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cover_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  cover_position INTEGER NOT NULL DEFAULT 50,
  content TEXT NOT NULL DEFAULT '[]',
  content_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  favorite_position INTEGER,
  full_width INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  trash_root_id TEXT,
  import_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_user_parent ON pages(user_id, parent_id, position);
CREATE INDEX pages_database ON pages(database_id) WHERE database_id IS NOT NULL;
CREATE INDEX pages_trash ON pages(user_id, trash_root_id) WHERE trashed_at IS NOT NULL;
CREATE INDEX pages_fav ON pages(user_id, favorite_position) WHERE is_favorite = 1;
CREATE UNIQUE INDEX pages_import_key ON pages(user_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, version)
);

CREATE TABLE db_properties (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','number','select','multi_select','date','checkbox','url')),
  options TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX db_properties_db ON db_properties(database_id, position);

CREATE TABLE row_values (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES db_properties(id) ON DELETE CASCADE,
  value_text TEXT,
  value_number REAL,
  value_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, property_id)
);

CREATE TABLE db_views (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('table')),
  config TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  format TEXT,
  target_parent_id TEXT,
  archive_path TEXT,
  progress TEXT NOT NULL DEFAULT '{}',
  report TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE VIRTUAL TABLE page_fts USING fts5(
  title, body, content='pages', content_rowid='rid', tokenize='trigram'
);
CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO page_fts(rowid, title, body) VALUES (new.rid, new.title, new.content_text);
END;
CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, body) VALUES ('delete', old.rid, old.title, old.content_text);
END;
CREATE TRIGGER pages_au AFTER UPDATE OF title, content_text ON pages BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, body) VALUES ('delete', old.rid, old.title, old.content_text);
  INSERT INTO page_fts(rowid, title, body) VALUES (new.rid, new.title, new.content_text);
END;
`,
};
