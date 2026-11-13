// Sharing: contracts and the pure rules both sides rely on. No Node or DOM API.
import { z } from 'zod';
import { emailSchema, pageIdSchema } from './api.ts';
import type { Breadcrumb, PageKind, PageNode } from './api.ts';
import type { DatabaseDto, DatabaseProperty, DatabaseRow } from './database.ts';

export const SHARE_SCOPES = ['page', 'subpages', 'all'] as const;
export type ShareScope = typeof SHARE_SCOPES[number];
export const scopeLabels: Record<ShareScope, string> = { page: '只有此頁面', subpages: '此頁面與子頁面', all: '此頁面、子頁面與資料庫' };
/** A shared database always comes with its rows; the wider scopes add what hangs below those rows. */
export const databaseScopeLabels: Record<ShareScope, string> = { page: '此資料庫與資料列', subpages: '資料庫、資料列與列底下的子頁面', all: '資料庫與其下所有內容' };
export const MEMBER_ROLES = ['viewer', 'editor'] as const;
export type MemberRole = typeof MEMBER_ROLES[number];
export const roleLabels: Record<MemberRole, string> = { viewer: '唯讀', editor: '可編輯' };
/** What a signed-in account gets by opening the public link; `off`: the read-only copy, like anybody without an account. */
export const accountLinkLabels: Record<MemberRole | 'off', string> = { off: '與未登入相同（只能閱讀）', viewer: '知道連結的人皆可唯讀', editor: '知道連結的人皆可編輯' };

/**
 * Whether a share placed on some page reaches a page below it. `below` lists the kinds on the way down, the shared
 * page itself excluded and the target included. A database is useless without its rows, so they always come along.
 */
export function scopeCovers(scope: ShareScope, below: readonly PageKind[]): boolean {
  if (scope === 'all') return true;
  if (scope === 'subpages') return !below.includes('database');
  return below.length === 0 || (below.length === 1 && below[0] === 'row');
}

export const shareScopeSchema = z.object({ scope: z.enum(SHARE_SCOPES) });
export const memberAddSchema = z.object({ email: emailSchema, role: z.enum(MEMBER_ROLES) });
export const memberRoleSchema = z.object({ role: z.enum(MEMBER_ROLES) });
/** What a signed-in account gets by opening the public link; null: nothing beyond reading it. */
export const accountRoleSchema = z.object({ role: z.enum(MEMBER_ROLES).nullable() });
/** 32 random bytes, base64url. */
export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** A signed-in account opening a public link, optionally at one of the pages below the shared one. */
export const openLinkSchema = z.object({ token: z.string().min(1).max(100), pageId: pageIdSchema.optional() });
export interface OpenedLinkDto { pageId: string }

export interface ShareMemberDto { userId: string; email: string; displayName: string; role: MemberRole }
export interface ShareDto {
  pageId: string; scope: ShareScope; members: ShareMemberDto[];
  /** The share's one link, the public one: read-only without an account. */
  link: { token: string; createdAt: number } | null;
  /** The role a signed-in account gets by opening that link, when one is set. Only while the link is on. */
  accountRole: MemberRole | null;
  /** Accounts that got in that way. */
  visitors: { userId: string; displayName: string }[];
}
/** A share on a page above this one that also reaches it. */
export interface InheritedShareDto { pageId: string; title: string; scope: ShareScope; link: boolean; members: number; accountRole: MemberRole | null }
export interface ShareStateDto { share: ShareDto | null; inherited: InheritedShareDto[] }
export interface OutgoingShareDto { pageId: string; title: string; icon: string | null; kind: PageKind; scope: ShareScope; link: boolean; members: number; accountRole: MemberRole | null; updatedAt: number }
/** Something shared with the reader: the shared page and what the scope reaches below it (rows excluded). */
export interface IncomingShareDto { pageId: string; role: MemberRole; scope: ShareScope; owner: { id: string; name: string }; tree: PageNode[] }
export interface SharesDto { outgoing: OutgoingShareDto[]; incoming: IncomingShareDto[] }

export const publicLinkPath = (token: string, pageId?: string): string => `/s/${token}${pageId ? `/${pageId}` : ''}`;
export const publicFileUrl = (token: string, rest: string): string => `/api/public/${token}/files/${rest}`;

// ---- What a visitor of a public link receives ----
export interface PublicNode { id: string; parentId: string | null; kind: PageKind; title: string; icon: string | null }
export interface PublicShareDto { rootId: string; scope: ShareScope; tree: PublicNode[] }
/** Instead of the above, for a signed-in account the link takes into the page itself: the app opens it there. */
export interface AccountLinkDto { account: true }
export interface PublicPageDto {
  page: { id: string; kind: PageKind; databaseId: string | null; title: string; icon: string | null; coverUrl: string | null; coverPosition: number; fullWidth: boolean; content: unknown[]; updatedAt: number };
  breadcrumbs: Breadcrumb[];
  /** A database page: its structure and every row. */
  database?: { meta: DatabaseDto; rows: DatabaseRow[] };
  /** A row page: its cells and the columns they belong to. */
  row?: { values: DatabaseRow['values']; properties: DatabaseProperty[] };
}

export const UNREACHABLE_PAGE = '無法存取的頁面';
const FILE_PREFIX = '/api/files/';
const PAGE_HREF = /^\/p\/([0-9a-f-]{36})(?:[/?#].*)?$/i;

/**
 * Page content as a visitor of a public link may see it: no discussion marks, links to pages outside the share
 * replaced by a neutral text or reduced to their plain text (neither their id nor their title leaves the server),
 * links to pages inside it pointing at the link's own address, and attachment addresses at its file endpoint.
 */
export function publicContent(content: unknown[], token: string, reachable: ReadonlySet<string>): unknown[] {
  const outside = (item: unknown): boolean => {
    if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'link') return false;
    const href = (item as { href?: unknown }).href, page = typeof href === 'string' ? PAGE_HREF.exec(href)?.[1] : undefined;
    return page !== undefined && !reachable.has(page);
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'href') { const page = PAGE_HREF.exec(value)?.[1]; if (page) return publicLinkPath(token, page); }
      return (key === 'url' || key === 'href') && value.startsWith(FILE_PREFIX) ? publicFileUrl(token, value.slice(FILE_PREFIX.length)) : value;
    }
    // An ordinary link to one of the owner's pages outside the share keeps its text and loses its address.
    if (Array.isArray(value)) return value.flatMap(item => outside(item) ? [walk((item as { content?: unknown }).content ?? [])].flat() : [walk(item)]);
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (node.type === 'pageLink') {
      const pageId = (node.props as { pageId?: unknown } | undefined)?.pageId;
      if (typeof pageId !== 'string' || !reachable.has(pageId)) return { type: 'text', text: UNREACHABLE_PAGE, styles: {} };
    }
    return Object.fromEntries(Object.entries(node).map(([name, child]) => [name,
      name === 'styles' && child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).filter(([style]) => style !== 'annotation')) : walk(child, name)]));
  };
  return content.map(item => walk(item));
}

/**
 * Rewrites the title snapshot that page mentions carry. `titleOf` is called for every mention in document order with
 * the mentioned page, the title stored with the mention and the id of the block the mention is in; it answers the
 * title to store instead, or undefined to leave the mention as it is.
 */
export function mapPageLinkTitles(content: unknown[], titleOf: (pageId: string, title: string, blockId: string) => string | undefined): unknown[] {
  const walk = (value: unknown, blockId: string): unknown => {
    if (Array.isArray(value)) return value.map(item => walk(item, blockId));
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    if (node.type === 'pageLink' && node.props && typeof node.props === 'object') {
      const props = node.props as { pageId?: unknown; title?: unknown };
      const title = typeof props.pageId === 'string' ? titleOf(props.pageId, typeof props.title === 'string' ? props.title : '', blockId) : undefined;
      return title === undefined ? value : { ...node, props: { ...props, title } };
    }
    const inside = typeof node.id === 'string' ? node.id : blockId;
    return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, walk(child, inside)]));
  };
  return content.map(item => walk(item, ''));
}
