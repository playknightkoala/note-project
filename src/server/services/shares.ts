import { randomBytes } from 'node:crypto';
import type { Db } from '../db/driver.ts';
import type { PageKind, PageNode } from '../../shared/api.ts';
import type { IncomingShareDto, InheritedShareDto, MemberRole, OutgoingShareDto, ShareDto, ShareScope, ShareStateDto } from '../../shared/shares.ts';
import { scopeCovers } from '../../shared/shares.ts';
import { AppError } from '../../shared/errors.ts';
import { loadPage } from './pages.ts';
import type { PageRow } from './pages.ts';
import { scopePages } from './access.ts';

interface ShareRow { page_id: string; user_id: string; scope: ShareScope; link_token: string | null; link_created_at: number | null; created_at: number; updated_at: number; account_role: MemberRole | null }

/** The shares that reach an account: those that list it, and those whose public link gives accounts a role and which it has opened. */
const REACHES = `(EXISTS(SELECT 1 FROM share_members m WHERE m.page_id = s.page_id AND m.user_id = ?)
  OR (s.account_role IS NOT NULL AND EXISTS(SELECT 1 FROM share_visitors v WHERE v.page_id = s.page_id AND v.user_id = ?)))`;
const stronger = (a: MemberRole | null, b: MemberRole | null): MemberRole => a === 'editor' || b === 'editor' ? 'editor' : 'viewer';

/** Only the owner manages a share; a row is shared through its database. */
function ownPage(db: Db, ownerId: string, pageId: string): PageRow {
  const page = loadPage(db, ownerId, pageId);
  if (page.kind === 'row') throw new AppError('bad_request', '資料列無法單獨分享，請分享它所屬的資料庫。');
  return page;
}
const find = (db: Db, ownerId: string, pageId: string) => db.get<ShareRow>('SELECT * FROM page_shares WHERE page_id = ? AND user_id = ?', pageId, ownerId);
function ensure(db: Db, ownerId: string, pageId: string, now: number): ShareRow {
  ownPage(db, ownerId, pageId);
  db.run('INSERT OR IGNORE INTO page_shares (page_id, user_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', pageId, ownerId, 'page', now, now);
  return find(db, ownerId, pageId)!;
}
const touch = (db: Db, pageId: string, now: number) => db.run('UPDATE page_shares SET updated_at = ? WHERE page_id = ?', now, pageId);

function shareDto(db: Db, row: ShareRow): ShareDto {
  const members = db.all<{ user_id: string; email: string; display_name: string; role: MemberRole }>(
    'SELECT m.user_id, u.email, u.display_name, m.role FROM share_members m JOIN users u ON u.id = m.user_id WHERE m.page_id = ? ORDER BY m.created_at, m.user_id', row.page_id);
  const visitors = row.account_role ? db.all<{ user_id: string; display_name: string }>(
    'SELECT v.user_id, u.display_name FROM share_visitors v JOIN users u ON u.id = v.user_id WHERE v.page_id = ? ORDER BY v.created_at, v.user_id', row.page_id) : [];
  return { pageId: row.page_id, scope: row.scope, link: row.link_token ? { token: row.link_token, createdAt: row.link_created_at ?? row.updated_at } : null,
    members: members.map(member => ({ userId: member.user_id, email: member.email, displayName: member.display_name, role: member.role })),
    accountRole: row.account_role, visitors: visitors.map(visitor => ({ userId: visitor.user_id, displayName: visitor.display_name })) };
}

/** The page's own share and the shares above it that also reach it, so the owner sees every way the page is exposed. */
export function shareState(db: Db, ownerId: string, pageId: string): ShareStateDto {
  const page = loadPage(db, ownerId, pageId, { allowTrashed: true });
  const own = find(db, ownerId, pageId);
  const inherited: InheritedShareDto[] = [], below: PageKind[] = [page.kind], seen = new Set([page.id]);
  let parentId = page.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = db.get<PageRow>('SELECT * FROM pages WHERE id = ? AND user_id = ?', parentId, ownerId);
    if (!parent) break;
    const share = find(db, ownerId, parent.id);
    if (share && scopeCovers(share.scope, below)) {
      const members = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM share_members WHERE page_id = ?', parent.id)?.n ?? 0);
      if (share.link_token || members) inherited.push({ pageId: parent.id, title: parent.title, scope: share.scope, link: !!share.link_token, members, accountRole: share.account_role });
    }
    below.unshift(parent.kind);
    parentId = parent.parent_id;
  }
  return { share: own ? shareDto(db, own) : null, inherited };
}

export function setScope(db: Db, ownerId: string, pageId: string, scope: ShareScope, now: number): ShareStateDto {
  return db.transaction(() => {
    ensure(db, ownerId, pageId, now);
    db.run('UPDATE page_shares SET scope = ?, updated_at = ? WHERE page_id = ? AND user_id = ?', scope, now, pageId, ownerId);
    return shareState(db, ownerId, pageId);
  });
}

/** Stops sharing altogether: the link stops working and every member loses access. */
export function removeShare(db: Db, ownerId: string, pageId: string): void {
  loadPage(db, ownerId, pageId, { allowTrashed: true });
  db.run('DELETE FROM page_shares WHERE page_id = ? AND user_id = ?', pageId, ownerId);
}

/**
 * A share has one link, the public one. Switching it on always issues a new address; an address that was switched
 * off never works again. Without an account it gives read access; what it gives a signed-in account is a setting of
 * the link (`setAccountRole`) and ends with it.
 */
export function enableLink(db: Db, ownerId: string, pageId: string, now: number): ShareStateDto {
  return db.transaction(() => {
    ensure(db, ownerId, pageId, now);
    db.run('UPDATE page_shares SET link_token = ?, link_created_at = ?, updated_at = ? WHERE page_id = ? AND user_id = ? AND link_token IS NULL', randomBytes(32).toString('base64url'), now, now, pageId, ownerId);
    return shareState(db, ownerId, pageId);
  });
}
export function disableLink(db: Db, ownerId: string, pageId: string, now: number): ShareStateDto {
  return db.transaction(() => {
    loadPage(db, ownerId, pageId, { allowTrashed: true });
    if (db.run('UPDATE page_shares SET link_token = NULL, link_created_at = NULL, account_role = NULL, updated_at = ? WHERE page_id = ? AND user_id = ?', now, pageId, ownerId).changes) {
      db.run('DELETE FROM share_visitors WHERE page_id = ?', pageId);
    }
    return shareState(db, ownerId, pageId);
  });
}

/**
 * What a signed-in account gets by opening the public link: a role, or (null) nothing beyond the read-only copy
 * everybody gets. Only while the link is on. Taking the role away forgets who had come in: they lose it at once,
 * and the page leaves their lists.
 */
export function setAccountRole(db: Db, ownerId: string, pageId: string, role: MemberRole | null, now: number): ShareStateDto {
  return db.transaction(() => {
    loadPage(db, ownerId, pageId, { allowTrashed: true });
    const share = find(db, ownerId, pageId);
    if (role !== null && !share?.link_token) throw new AppError('bad_request', '請先開啟公開連結，再設定知道連結的本站帳號可以做什麼。');
    db.run('UPDATE page_shares SET account_role = ?, updated_at = ? WHERE page_id = ? AND user_id = ?', role, now, pageId, ownerId);
    if (role === null) db.run('DELETE FROM share_visitors WHERE page_id = ?', pageId);
    return shareState(db, ownerId, pageId);
  });
}

/** Adds an account by its exact e-mail address, or changes the role it already has. */
export function setMember(db: Db, ownerId: string, pageId: string, email: string, role: MemberRole, now: number): ShareStateDto {
  return db.transaction(() => {
    ownPage(db, ownerId, pageId);
    const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ? AND disabled_at IS NULL', email);
    // A disabled account is answered exactly like an unknown address.
    if (!user) throw new AppError('not_found', '找不到這個帳號，請確認對方註冊時使用的 email。');
    if (user.id === ownerId) throw new AppError('bad_request', '這是你自己的帳號。');
    ensure(db, ownerId, pageId, now);
    db.run('INSERT INTO share_members (page_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(page_id, user_id) DO UPDATE SET role = excluded.role', pageId, user.id, role, now);
    touch(db, pageId, now);
    return shareState(db, ownerId, pageId);
  });
}
export function changeMember(db: Db, ownerId: string, pageId: string, userId: string, role: MemberRole | null, now: number): ShareStateDto {
  return db.transaction(() => {
    // Also while the page is in the trash: a member taken off the list must not get access back when it is restored.
    loadPage(db, ownerId, pageId, { allowTrashed: true });
    if (!find(db, ownerId, pageId)) throw new AppError('not_found');
    const changes = role === null
      ? db.run('DELETE FROM share_members WHERE page_id = ? AND user_id = ?', pageId, userId).changes
      : db.run('UPDATE share_members SET role = ? WHERE page_id = ? AND user_id = ?', role, pageId, userId).changes;
    if (changes !== 1) throw new AppError('not_found', '這個帳號不在共用名單中。');
    touch(db, pageId, now);
    return shareState(db, ownerId, pageId);
  });
}

/** Everything the user shares that somebody can actually reach. */
export function outgoingShares(db: Db, ownerId: string): OutgoingShareDto[] {
  return db.all<ShareRow & { title: string; icon: string | null; kind: PageKind; members: number }>(
    `SELECT s.*, p.title, p.icon, p.kind, (SELECT COUNT(*) FROM share_members m WHERE m.page_id = s.page_id) AS members
     FROM page_shares s JOIN pages p ON p.id = s.page_id AND p.user_id = s.user_id AND p.trashed_at IS NULL WHERE s.user_id = ? ORDER BY s.updated_at DESC, s.page_id`, ownerId)
    .filter(row => row.link_token !== null || Number(row.members) > 0)
    .map(row => ({ pageId: row.page_id, title: row.title, icon: row.icon, kind: row.kind, scope: row.scope, link: row.link_token !== null, members: Number(row.members), accountRole: row.account_role, updatedAt: row.updated_at }));
}

/** What other accounts share with the user. A share that lies inside another one from the same owner is shown there only. */
export function incomingShares(db: Db, userId: string): IncomingShareDto[] {
  const rows = db.all<{ page_id: string; scope: ShareScope; owner_id: string; member_role: MemberRole | null; account_role: MemberRole | null; owner_name: string }>(
    `SELECT s.page_id, s.scope, s.user_id AS owner_id, s.account_role, u.display_name AS owner_name,
       (SELECT m.role FROM share_members m WHERE m.page_id = s.page_id AND m.user_id = ?) AS member_role
     FROM page_shares s
     JOIN pages p ON p.id = s.page_id AND p.user_id = s.user_id AND p.trashed_at IS NULL
     JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
     WHERE s.user_id <> ? AND ${REACHES} ORDER BY u.display_name, p.title, s.page_id`, userId, userId, userId, userId);
  const shares = rows.map(row => {
    const pages = scopePages(db, row.owner_id, row.page_id, row.scope).filter(page => page.kind !== 'row');
    const parents = new Set(pages.map(page => page.parent_id));
    const tree: PageNode[] = pages.map(page => ({ id: page.id, parentId: page.id === row.page_id ? null : page.parent_id, kind: page.kind, title: page.title, icon: page.icon,
      position: page.position, isFavorite: false, favoritePosition: null, hasChildren: parents.has(page.id), updatedAt: page.updated_at }));
    return { pageId: row.page_id, role: stronger(row.member_role, row.account_role), scope: row.scope, owner: { id: row.owner_id, name: row.owner_name }, tree };
  });
  const inside = (share: IncomingShareDto) => shares.some(other => other !== share && other.owner.id === share.owner.id && other.tree.some(node => node.id === share.pageId && node.id !== other.pageId));
  return shares.filter(share => !inside(share));
}

/**
 * A member removes the share from their own list and loses access with it. Where the public link gives accounts a
 * role, opening the link again brings it back.
 */
export function leaveShare(db: Db, userId: string, pageId: string): void {
  const left = db.run('DELETE FROM share_members WHERE page_id = ? AND user_id = ?', pageId, userId).changes
    + db.run('DELETE FROM share_visitors WHERE page_id = ? AND user_id = ?', pageId, userId).changes;
  if (left === 0) throw new AppError('not_found');
}

/** Every page shared with the user through any share, each listed once. Used by the list a device syncs from. */
export function incomingPages(db: Db, userId: string): { id: string; kind: PageKind; ownerId: string }[] {
  const found = new Map<string, { id: string; kind: PageKind; ownerId: string }>();
  for (const share of db.all<{ page_id: string; scope: ShareScope; owner_id: string }>(
    `SELECT s.page_id, s.scope, s.user_id AS owner_id FROM page_shares s
     JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL WHERE s.user_id <> ? AND ${REACHES}`, userId, userId, userId)) {
    for (const page of scopePages(db, share.owner_id, share.page_id, share.scope)) found.set(page.id, { id: page.id, kind: page.kind, ownerId: share.owner_id });
  }
  return [...found.values()];
}
