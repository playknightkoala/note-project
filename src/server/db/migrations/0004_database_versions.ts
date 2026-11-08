export const migration = {
  id: '0004_database_versions',
  up: `
ALTER TABLE pages ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pages ADD COLUMN attributes_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER row_title_version AFTER UPDATE OF title ON pages
WHEN new.kind = 'row' AND old.title <> new.title AND old.attributes_version = new.attributes_version
BEGIN
  UPDATE pages SET attributes_version = attributes_version + 1 WHERE id = new.id AND user_id = new.user_id;
END;
`,
};
