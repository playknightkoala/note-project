// The external-content column must have the same name as pages.content_text.
// Rebuild existing indexes so installations with notes are immediately searchable.
export const migration = {
  id: '0003_search_content',
  up: `
DROP TRIGGER pages_ai;
DROP TRIGGER pages_ad;
DROP TRIGGER pages_au;
DROP TABLE page_fts;
CREATE VIRTUAL TABLE page_fts USING fts5(
  title, content_text, content='pages', content_rowid='rid', tokenize='trigram'
);
CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO page_fts(rowid, title, content_text) VALUES (new.rid, new.title, new.content_text);
END;
CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, content_text) VALUES ('delete', old.rid, old.title, old.content_text);
END;
CREATE TRIGGER pages_au AFTER UPDATE OF title, content_text ON pages BEGIN
  INSERT INTO page_fts(page_fts, rowid, title, content_text) VALUES ('delete', old.rid, old.title, old.content_text);
  INSERT INTO page_fts(rowid, title, content_text) VALUES (new.rid, new.title, new.content_text);
END;
INSERT INTO page_fts(page_fts) VALUES ('rebuild');
`,
};
