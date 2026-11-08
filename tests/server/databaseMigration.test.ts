import { expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/driver.ts';
import { migrate, migrations } from '../../src/server/db/migrate.ts';

it('upgrades existing table views without losing identity/configuration and remains idempotent with cascading deletion', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db, migrations.filter(migration => migration.id !== '0006_database_views'));
    const owner = crypto.randomUUID(); const page = crypto.randomUUID(); const view = crypto.randomUUID();
    db.run("INSERT INTO users (id,email,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,'合成帳號',?,'admin',1,1)", owner, `${owner}@example.test`, crypto.randomUUID());
    db.run("INSERT INTO pages (id,user_id,kind,title,created_at,updated_at) VALUES (?,?,'database','保留資料庫',1,1)", page, owner);
    const config = JSON.stringify({ sorts: [{ propertyId: 'title', direction: 'desc' }], filters: [], columns: [] });
    db.run("INSERT INTO db_views VALUES (?,?,?,'table',?,1024,1)", view, page, '保留視圖', config);
    expect(migrate(db)).toEqual(['0006_database_views']);
    expect(migrate(db)).toEqual([]);
    expect(db.get('SELECT * FROM db_views WHERE id = ?', view)).toMatchObject({ database_id: page, name: '保留視圖', type: 'table', config, position: 1024, created_at: 1 });
    for (const type of ['list', 'board']) db.run("INSERT INTO db_views VALUES (?,?,?,?,'{}',2048,1)", crypto.randomUUID(), page, type, type);
    db.run('DELETE FROM pages WHERE id = ? AND user_id = ?', page, owner);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM db_views')?.n).toBe(0);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { db.close(); }
});
