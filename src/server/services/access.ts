import type { Db } from '../db/driver.ts';
import type { Breadcrumb, PageAccess, PageKind, PageResponse } from '../../shared/api.ts';
import type { MemberRole, ShareScope } from '../../shared/shares.ts';
import { scopeCovers } from '../../shared/shares.ts';
import { AppError } from '../../shared/errors.ts';
import { breadcrumbs, toPageDto } from './pages.ts';
import type { PageRow } from './pages.ts';

/**
 * The only place where a page is looked up without the reader's own `user_id`. Every route that serves somebody
 * else's page resolves the reader's access here first and then calls the ordinary services with `ownerId`; a route
 * that does not, keeps passing the reader's own id and therefore still answers "not found".
 */

interface Step { id: string; user_id: string; parent_id: string | null; kind: PageKind; title: string; icon: string | null; trashed_at: number | null }
const STEP = 'id, user_id, parent_id, kind, title, icon, trashed_at';
const MAX_DEPTH = 64;

export interface Access {
  /** Whose page it is: the id to pass to the services. */
  ownerId: string;
  role: 'owner' | MemberRole;
  /** For a member: the path from the shared page they reach it through down to the page itself. */
  chain: Breadcrumb[];
  member?: PageAccess;
  /** Shared pages the reader reaches only because every signed-in account with the link may; see `recordVisit`. */
  linkRoots?: string[];
}
export type Need = 'view' | 'comment' | 'edit';

const notFound = () => new AppError('not_found', '找不到頁面。');
const rank = (role: MemberRole): number => role === 'editor' ? 2 : 1;

/** The page and its ancestors, nearest first. */
function ancestry(db: Db, pageId: string): Step[] {
  const steps: Step[] = [], seen = new Set<string>();
  let next: string | null = pageId;
  while (next && !seen.has(next) && steps.length < MAX_DEPTH) {
    seen.add(next);
    const step: Step | undefined = db.get<Step>(`SELECT ${STEP} FROM pages WHERE id = ?`, next);
    if (!step) break;
    steps.push(step);
    next = step.parent_id;
  }
  return steps;
}
const crumbs = (steps: Step[]): Breadcrumb[] => steps.map(step => ({ id: step.id, title: step.title, icon: step.icon, kind: step.kind })).reverse();

/**
 * Anybody but the owner gets "not found" unless a share on the page or above it reaches the page and either lists
 * them or is open to every signed-in account that has the link (the page's address).
 */
export function resolveAccess(db: Db, viewerId: string, pageId: string): Access {
  const steps = ancestry(db, pageId);
  const page = steps[0];
  if (!page) throw notFound();
  if (page.user_id === viewerId) return { ownerId: viewerId, role: 'owner', chain: [] };
  // Somebody else's page: never from the trash, and never once the owner's account is disabled.
  if (steps.some(step => step.trashed_at !== null || step.user_id !== page.user_id)) throw notFound();
  let role: MemberRole | undefined, top = -1;
  const linkRoots: string[] = [];
  for (let index = 0; index < steps.length; index++) {
    const share = db.get<{ scope: ShareScope; account_role: MemberRole | null; member_role: MemberRole | null }>(
      `SELECT s.scope, s.account_role, (SELECT m.role FROM share_members m WHERE m.page_id = s.page_id AND m.user_id = ?) AS member_role
       FROM page_shares s WHERE s.page_id = ? AND s.user_id = ?`, viewerId, steps[index]!.id, page.user_id);
    if (!share || (!share.member_role && !share.account_role) || !scopeCovers(share.scope, steps.slice(0, index).reverse().map(step => step.kind))) continue;
    for (const granted of [share.member_role, share.account_role]) if (granted && (!role || rank(granted) > rank(role))) role = granted;
    if (!share.member_role) linkRoots.push(steps[index]!.id);
    top = index;
  }
  if (!role) throw notFound();
  const owner = db.get<{ display_name: string; disabled_at: number | null }>('SELECT display_name, disabled_at FROM users WHERE id = ?', page.user_id);
  if (!owner || owner.disabled_at !== null) throw notFound();
  const chain = crumbs(steps.slice(0, top + 1));
  return { ownerId: page.user_id, role, chain, member: { role, rootId: steps[top]!.id, owner: { id: page.user_id, name: owner.display_name } }, ...(linkRoots.length ? { linkRoots } : {}) };
}

/**
 * Remembers that an account opened a page through "anyone signed in with the link". From then on the shared page is
 * listed with what is shared with them and kept on their devices; knowing the address alone already gave access.
 */
export function recordVisit(db: Db, viewerId: string, access: Access, now: number): void {
  for (const pageId of access.linkRoots ?? []) db.run('INSERT OR IGNORE INTO share_visitors (page_id, user_id, created_at) VALUES (?, ?, ?)', pageId, viewerId, now);
}

/** A stranger gets 404 (the page does not exist for them); a member whose role is too low gets 403. */
export function requireAccess(db: Db, viewerId: string, pageId: string, need: Need): Access {
  const access = resolveAccess(db, viewerId, pageId);
  if (need === 'edit' && access.role === 'viewer') throw new AppError('forbidden', '這個頁面以唯讀方式與你共用，無法修改。');
  return access;
}

/**
 * The one builder of what a reader receives for a page. The list a device syncs from and the page itself must be
 * built identically, or the device would download every shared page again on each check.
 */
export function pageResponse(db: Db, access: Access, row: PageRow): PageResponse {
  if (!access.member) return { page: toPageDto(row), breadcrumbs: breadcrumbs(db, access.ownerId, row) };
  // Nothing of the owner's own organisation leaves: no favourite flag, no parent above the shared page.
  const page = { ...toPageDto(row), isFavorite: false, parentId: row.id === access.member.rootId ? null : row.parent_id };
  return { page, breadcrumbs: access.chain, access: access.member };
}
/** The same for a row of a database the reader has already been granted: every share that reaches a database reaches its rows. */
export function rowResponse(db: Db, access: Access, trail: Breadcrumb[], row: PageRow): PageResponse {
  const chain = [...trail, { id: row.id, title: row.title, icon: row.icon, kind: row.kind }];
  if (!access.member) return { page: toPageDto(row), breadcrumbs: chain };
  return { page: { ...toPageDto(row), isFavorite: false }, breadcrumbs: chain, access: access.member };
}

const CONDITION: Record<ShareScope, string> = { all: '1', subpages: 'sub.blocked = 0', page: "(sub.depth = 0 OR (sub.depth = 1 AND p.kind = 'row'))" };
const SUBTREE = `WITH RECURSIVE sub(id, depth, blocked) AS (
    SELECT id, 0, 0 FROM pages WHERE id = ? AND user_id = ? AND trashed_at IS NULL
    UNION ALL
    SELECT p.id, sub.depth + 1, sub.blocked OR p.kind = 'database' FROM pages p JOIN sub ON p.parent_id = sub.id
    WHERE p.trashed_at IS NULL AND p.user_id = ? AND sub.depth < ${MAX_DEPTH})`;

export interface ScopedPage { id: string; parent_id: string | null; kind: PageKind; title: string; icon: string | null; position: number; updated_at: number }
/** Every page a share reaches, the shared page first. Must agree with `scopeCovers`. */
export function scopePages(db: Db, ownerId: string, rootId: string, scope: ShareScope): ScopedPage[] {
  return db.all<ScopedPage>(`${SUBTREE} SELECT p.id, p.parent_id, p.kind, p.title, p.icon, p.position, p.updated_at FROM sub JOIN pages p ON p.id = sub.id
    WHERE ${CONDITION[scope]} ORDER BY sub.depth, p.position, p.created_at`, rootId, ownerId, ownerId);
}
/** Whether a page the share reaches shows this file: as its cover, or anywhere in its content. */
export function scopeShowsFile(db: Db, ownerId: string, rootId: string, scope: ShareScope, fileId: string): boolean {
  return !!db.get(`${SUBTREE} SELECT 1 FROM sub JOIN pages p ON p.id = sub.id
    WHERE ${CONDITION[scope]} AND (p.cover_file_id = ? OR instr(p.content, ?) > 0) LIMIT 1`, rootId, ownerId, ownerId, fileId, `/api/files/${fileId}`);
}

export interface LinkShare { pageId: string; ownerId: string; scope: ShareScope; token: string }
/** A public link, while it is switched on, its page is not in the trash and its owner's account is active. */
export function resolveLink(db: Db, token: string): LinkShare {
  const share = /^[A-Za-z0-9_-]{43}$/.test(token) ? db.get<{ page_id: string; user_id: string; scope: ShareScope }>(
    `SELECT s.page_id, s.user_id, s.scope FROM page_shares s JOIN pages p ON p.id = s.page_id AND p.user_id = s.user_id AND p.trashed_at IS NULL
     JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL WHERE s.link_token = ?`, token) : undefined;
  if (!share) throw notFound();
  return { pageId: share.page_id, ownerId: share.user_id, scope: share.scope, token };
}
/** The path from the link's page down to `pageId`, when the link reaches it. */
export function linkChain(db: Db, link: LinkShare, pageId: string): Breadcrumb[] {
  const steps = ancestry(db, pageId);
  const top = steps.findIndex(step => step.id === link.pageId);
  if (top < 0 || steps.slice(0, top + 1).some(step => step.trashed_at !== null || step.user_id !== link.ownerId)) throw notFound();
  if (!scopeCovers(link.scope, steps.slice(0, top).reverse().map(step => step.kind))) throw notFound();
  return crumbs(steps.slice(0, top + 1));
}
