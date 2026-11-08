export const migration = {
  id: '0002_cover_preset',
  up: `
ALTER TABLE pages ADD COLUMN cover_preset TEXT;
`,
};
