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

it('makes what accounts get a setting of the public link: kept where the link is on, dropped where it is not', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db, migrations.filter(migration => migration.id !== '0011_share_single_link'));
    const owner = crypto.randomUUID(), guest = crypto.randomUUID();
    for (const id of [owner, guest]) db.run("INSERT INTO users (id,email,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,'合成帳號',?,'user',1,1)", id, `${id}@example.test`, crypto.randomUUID());
    const share = (token: string | null, role: string | null, member = false) => {
      const id = crypto.randomUUID();
      db.run("INSERT INTO pages (id,user_id,kind,title,created_at,updated_at) VALUES (?,?,'page','合成頁面',1,1)", id, owner);
      db.run("INSERT INTO page_shares (page_id,user_id,scope,link_token,link_created_at,account_role,created_at,updated_at) VALUES (?,?,'page',?,?,?,1,7)", id, owner, token, token ? 3 : null, role);
      if (role) db.run('INSERT INTO share_visitors (page_id,user_id,created_at) VALUES (?,?,2)', id, guest);
      if (member) db.run("INSERT INTO share_members (page_id,user_id,role,created_at) VALUES (?,?,'editor',2)", id, guest);
      return id;
    };
    const open = share('p'.repeat(43), null), both = share('b'.repeat(43), 'viewer'), accounts = share(null, 'editor'), listed = share(null, 'editor', true);
    expect(migrate(db)).toEqual(['0011_share_single_link']);
    expect(migrate(db)).toEqual([]);
    const row = (id: string) => db.get<{ link_token: string | null; link_created_at: number | null; account_role: string | null }>('SELECT link_token, link_created_at, account_role FROM page_shares WHERE page_id = ?', id)!;
    const seen = (id: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM share_visitors WHERE page_id = ?', id)?.n;
    expect(row(open)).toEqual({ link_token: 'p'.repeat(43), link_created_at: 3, account_role: null });
    // Public link and a role for accounts: nothing changes, and those who had opened it stay.
    expect(row(both)).toEqual({ link_token: 'b'.repeat(43), link_created_at: 3, account_role: 'viewer' });
    expect(seen(both)).toBe(1);
    // Open to accounts through the page's own address only: that ends, and no public link is switched on for the owner.
    for (const id of [accounts, listed]) {
      expect(row(id)).toEqual({ link_token: null, link_created_at: null, account_role: null });
      expect(seen(id)).toBe(0);
    }
    // An account listed by name keeps its place.
    expect(db.get<{ role: string }>('SELECT role FROM share_members WHERE page_id = ? AND user_id = ?', listed, guest)?.role).toBe('editor');
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { db.close(); }
});
