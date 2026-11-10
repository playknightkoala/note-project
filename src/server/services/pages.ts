import type { Db } from '../db/driver.ts';
import type { Breadcrumb, PageDto, PageHeadDto, PageKind, PageNode, TrashItemDto, VersionDto } from '../../shared/api.ts';
import { emptyParagraph, parseBlocks } from '../../shared/blocks.ts';
import type { Block } from '../../shared/blocks.ts';
import { AppError } from '../../shared/errors.ts';
import { extractPlainText } from '../../shared/text.ts';
import { stripAnnotationAnchors } from '../../shared/annotations.ts';

export interface PageRow {
  rid: number; id: string; user_id: string; parent_id: string | null; kind: PageKind; database_id: string | null; position: number;
  title: string; icon: string | null; cover_file_id: string | null; cover_preset: string | null; cover_position: number; content: string; content_text: string;
  version: number; is_favorite: number; favorite_position: number | null; full_width: number; trashed_at: number | null;
  trash_root_id: string | null; import_key: string | null; created_at: number; updated_at: number;
  /** Who last wrote the content when it was not the owner (a member with edit access); null for the owner. */
  content_by?: string | null;
}

const GAP = 1024;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOTS_PER_PAGE = 100;

export const fileUrl = (fileId: string | null): string | null => fileId ? `/api/files/${fileId}` : null;

export function toPageDto(row: PageRow): PageDto {
  return { id: row.id, parentId: row.parent_id, kind: row.kind, databaseId: row.database_id, title: row.title, icon: row.icon,
    coverUrl: row.cover_file_id ? fileUrl(row.cover_file_id) : row.cover_preset, coverPosition: row.cover_position, fullWidth: row.full_width === 1,
    content: JSON.parse(row.content) as unknown[], version: row.version, isFavorite: row.is_favorite === 1,
    trashedAt: row.trashed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Loads one of the user's pages; foreign or missing ids are both "not found". */
export function loadPage(db: Db, userId: string, id: string, options: { allowTrashed?: boolean } = {}): PageRow {
  const row = db.get<PageRow>('SELECT * FROM pages WHERE id = ? AND user_id = ?', id, userId);
  if (!row || (!options.allowTrashed && row.trashed_at !== null)) throw new AppError('not_found', '找不到頁面。');
  return row;
}

export function breadcrumbs(db: Db, userId: string, row: PageRow): Breadcrumb[] {
  const chain: Breadcrumb[] = [];
  let current: PageRow | undefined = row;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift({ id: current.id, title: current.title, icon: current.icon, kind: current.kind });
    current = current.parent_id ? db.get<PageRow>('SELECT * FROM pages WHERE id = ? AND user_id = ?', current.parent_id, userId) : undefined;
  }
  return chain;
}

export function listTree(db: Db, userId: string): PageNode[] {
  const rows = db.all<PageRow & { has_children: number; shared: number }>(
    `SELECT p.id, p.parent_id, p.kind, p.title, p.icon, p.position, p.is_favorite, p.favorite_position, p.updated_at,
     EXISTS(SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.user_id = p.user_id AND c.trashed_at IS NULL AND c.kind <> 'row') AS has_children,
     EXISTS(SELECT 1 FROM page_shares s WHERE s.page_id = p.id AND (s.link_token IS NOT NULL OR s.account_role IS NOT NULL OR EXISTS(SELECT 1 FROM share_members m WHERE m.page_id = s.page_id))) AS shared
     FROM pages p WHERE p.user_id = ? AND p.trashed_at IS NULL AND p.kind <> 'row' ORDER BY p.parent_id, p.position, p.created_at`, userId);
  return rows.map(row => ({ id: row.id, parentId: row.parent_id, kind: row.kind, title: row.title, icon: row.icon, position: row.position,
    isFavorite: row.is_favorite === 1, favoritePosition: row.favorite_position, hasChildren: row.has_children === 1, updatedAt: row.updated_at,
    ...(row.shared === 1 ? { shared: true } : {}) }));
}

function siblings(db: Db, userId: string, parentId: string | null): { id: string; position: number }[] {
  return db.all<{ id: string; position: number }>(
    `SELECT id, position FROM pages WHERE user_id = ? AND trashed_at IS NULL AND kind <> 'row' AND parent_id ${parentId === null ? 'IS NULL' : '= ?'} ORDER BY position, created_at`,
    ...(parentId === null ? [userId] : [userId, parentId]));
}

/** Position for inserting at `index` among the siblings (excluding `movingId`); renormalizes when no gap is left. */
function positionAt(db: Db, userId: string, parentId: string | null, index: number, movingId?: string): number {
  let list = siblings(db, userId, parentId).filter(sibling => sibling.id !== movingId);
  const slot = Math.min(Math.max(index, 0), list.length);
  const before = list[slot - 1]?.position;
  const after = list[slot]?.position;
  if (before === undefined && after === undefined) return GAP;
  if (before === undefined) return after! - GAP;
  if (after === undefined) return before + GAP;
  if (after - before >= 2) return Math.floor((before + after) / 2);
  list.forEach((sibling, i) => db.run('UPDATE pages SET position = ? WHERE id = ?', (i + 1) * GAP, sibling.id));
  list = list.map((sibling, i) => ({ ...sibling, position: (i + 1) * GAP }));
  return Math.floor((list[slot - 1]!.position + list[slot]!.position) / 2);
}

export interface CreatePageInput { parentId: string | null; kind: 'page' | 'database'; title: string; afterId: string | null; icon: string | null }

export function createPage(db: Db, userId: string, input: CreatePageInput, now: number, pageId?: string): PageRow {
  return db.transaction(() => {
    if (input.parentId) {
      const parent = loadPage(db, userId, input.parentId);
      if (parent.kind === 'database') throw new AppError('bad_request', '資料庫底下只能新增資料列。');
    }
    let index = siblings(db, userId, input.parentId).length;
    if (input.afterId) {
      const list = siblings(db, userId, input.parentId);
      const at = list.findIndex(sibling => sibling.id === input.afterId);
      if (at >= 0) index = at + 1;
    }
    const position = positionAt(db, userId, input.parentId, index);
    const id = pageId ?? crypto.randomUUID();
    const content = JSON.stringify([emptyParagraph()]);
    const inserted = db.run(`INSERT ${pageId ? 'OR IGNORE ' : ''}INTO pages (id, user_id, parent_id, kind, position, title, icon, content, content_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`, id, userId, input.parentId, input.kind, position, input.title, input.icon, content, now, now);
    if (inserted.changes !== 1) throw new AppError('not_found');
    if (input.kind === 'database') {
      db.run('INSERT INTO db_views (id, database_id, name, type, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), id, '表格', 'table', '{}', GAP, now);
    }
    return loadPage(db, userId, id);
  });
}

export function headOf(row: PageRow): PageHeadDto { return { version: row.version, updatedAt: row.updated_at, title: row.title }; }

/**
 * Snapshot the outgoing content when the newest snapshot is older than the interval. What the owner wrote and what
 * members wrote are kept as two separate sets of the last N each: however often a member saves, none of the owner's
 * versions is pushed out of the history.
 */
function snapshotIfDue(db: Db, row: PageRow, now: number, reason: string, force = false): void {
  const latest = db.get<{ created_at: number; version: number }>('SELECT created_at, version FROM page_versions WHERE page_id = ? ORDER BY version DESC LIMIT 1', row.id);
  if (latest?.version === row.version) return;
  if (!force && latest && now - latest.created_at < SNAPSHOT_INTERVAL_MS) return;
  const writer = row.content_by ?? null, own = writer === null ? 1 : 0;
  db.run('INSERT INTO page_versions (id, page_id, version, title, content, reason, created_at, written_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    crypto.randomUUID(), row.id, row.version, row.title, row.content, reason, now, writer);
  db.run(`DELETE FROM page_versions WHERE page_id = ? AND (written_by IS NULL) = ? AND version NOT IN
    (SELECT version FROM page_versions WHERE page_id = ? AND (written_by IS NULL) = ? ORDER BY version DESC LIMIT ?)`, row.id, own, row.id, own, SNAPSHOTS_PER_PAGE);
}

/**
 * Optimistic-concurrency save: the row must still be at `expectedVersion`, otherwise 409 with the current head.
 * `actorId` is who writes when that is not the owner. Whenever the writer changes, the outgoing content is kept in
 * the page history regardless of the usual interval, so the owner can always get back what a member replaced.
 * The owner's explicit overwrite or restore keeps what it replaces as well; a member's repeated overwrites do not
 * each add a version.
 */
export function updateContent(db: Db, userId: string, id: string, content: unknown, expectedVersion: number, now: number, reason = 'autosave', actorId: string = userId): PageHeadDto {
  const parsed = parseBlocks(content);
  if ('error' in parsed) throw new AppError('bad_request', parsed.error);
  const text = extractPlainText(parsed.blocks);
  return db.transaction(() => {
    const row = loadPage(db, userId, id);
    if (row.version !== expectedVersion) throw new AppError('version_conflict', undefined, { current: headOf(row) });
    const writer = actorId === userId ? null : actorId;
    snapshotIfDue(db, row, now, reason, writer !== (row.content_by ?? null) || (reason !== 'autosave' && writer === null));
    const changes = db.run('UPDATE pages SET content = ?, content_text = ?, content_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?',
      parsed.json, text, writer, now, id, userId, expectedVersion).changes;
    if (changes !== 1) throw new AppError('version_conflict', undefined, { current: headOf(loadPage(db, userId, id)) });
    return { version: expectedVersion + 1, updatedAt: now, title: row.title };
  });
}

export interface PatchPageInput { title?: string | undefined; icon?: string | null | undefined; coverFileId?: string | null | undefined; coverPreset?: string | null | undefined; coverPosition?: number | undefined; fullWidth?: boolean | undefined }

export function patchPage(db: Db, userId: string, id: string, input: PatchPageInput, now: number): PageRow {
  return db.transaction(() => {
    const row = loadPage(db, userId, id);
    if (input.coverFileId) {
      const file = db.get<{ id: string }>('SELECT id FROM files WHERE id = ? AND user_id = ?', input.coverFileId, userId);
      if (!file) throw new AppError('not_found', '找不到封面圖片。');
    }
    // Metadata is not guarded by the content version: a title edit must never make a concurrent content save conflict.
    // A file cover and a preset cover are exclusive: setting either clears the other.
    let coverFileId = row.cover_file_id, coverPreset = row.cover_preset;
    if (input.coverFileId !== undefined) { coverFileId = input.coverFileId; if (input.coverFileId) coverPreset = null; }
    if (input.coverPreset !== undefined) { coverPreset = input.coverPreset; if (input.coverPreset) coverFileId = null; }
    db.run('UPDATE pages SET title = ?, icon = ?, cover_file_id = ?, cover_preset = ?, cover_position = ?, full_width = ?, updated_at = ? WHERE id = ?',
      input.title ?? row.title, input.icon === undefined ? row.icon : input.icon, coverFileId, coverPreset,
      input.coverPosition ?? row.cover_position, input.fullWidth === undefined ? row.full_width : (input.fullWidth ? 1 : 0), now, id);
    return loadPage(db, userId, id);
  });
}

function isDescendant(db: Db, userId: string, ancestorId: string, id: string): boolean {
  const hit = db.get<{ n: number }>(
    `WITH RECURSIVE sub(id) AS (SELECT id FROM pages WHERE id = ? AND user_id = ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
     SELECT COUNT(*) AS n FROM sub WHERE id = ?`, ancestorId, userId, id);
  return Number(hit?.n ?? 0) > 0;
}

export function movePage(db: Db, userId: string, id: string, parentId: string | null, index: number, now: number): PageRow {
  return db.transaction(() => {
    const row = loadPage(db, userId, id);
    if (row.kind === 'row') throw new AppError('bad_request', '資料列只能在資料庫內排序。');
    if (parentId) {
      const parent = loadPage(db, userId, parentId);
      if (parent.kind === 'database') throw new AppError('bad_request', '頁面不能移到資料庫底下。');
      if (parentId === id || isDescendant(db, userId, id, parentId)) throw new AppError('bad_request', '不能把頁面移到自己或子頁面底下。');
    }
    const position = positionAt(db, userId, parentId, index, id);
    db.run('UPDATE pages SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?', parentId, position, now, id);
    return loadPage(db, userId, id);
  });
}

export function setFavorite(db: Db, userId: string, id: string, favorite: boolean, now: number): PageRow {
  return db.transaction(() => {
    loadPage(db, userId, id);
    const max = db.get<{ m: number | null }>('SELECT MAX(favorite_position) AS m FROM pages WHERE user_id = ? AND is_favorite = 1', userId)?.m ?? 0;
    db.run('UPDATE pages SET is_favorite = ?, favorite_position = ?, updated_at = ? WHERE id = ?', favorite ? 1 : 0, favorite ? Number(max) + GAP : null, now, id);
    return loadPage(db, userId, id);
  });
}

const subtreeIds = (db: Db, userId: string, id: string): string[] => db.all<{ id: string }>(
  `WITH RECURSIVE sub(id) AS (SELECT id FROM pages WHERE id = ? AND user_id = ? UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id) SELECT id FROM sub`,
  id, userId).map(row => row.id);

export function trashPage(db: Db, userId: string, id: string, now: number): number {
  return db.transaction(() => {
    loadPage(db, userId, id);
    const ids = subtreeIds(db, userId, id);
    for (const pageId of ids) {
      db.run('UPDATE pages SET trashed_at = ?, trash_root_id = ?, is_favorite = 0, favorite_position = NULL, updated_at = ? WHERE id = ? AND trashed_at IS NULL', now, id, now, pageId);
      // A public address must not come back to life when the page is restored; switching it on again issues a new one.
      db.run('UPDATE page_shares SET link_token = NULL, link_created_at = NULL, updated_at = ? WHERE page_id = ? AND link_token IS NOT NULL', now, pageId);
    }
    return ids.length;
  });
}

export function listTrash(db: Db, userId: string): TrashItemDto[] {
  return db.all<PageRow & { descendants: number }>(
    `SELECT p.*, (SELECT COUNT(*) FROM pages d WHERE d.trash_root_id = p.id) - 1 AS descendants
     FROM pages p WHERE p.user_id = ? AND p.trashed_at IS NOT NULL AND p.trash_root_id = p.id ORDER BY p.trashed_at DESC`, userId)
    .map(row => ({ id: row.id, title: row.title, icon: row.icon, kind: row.kind, trashedAt: row.trashed_at!, descendantCount: Number(row.descendants) }));
}

export function restorePage(db: Db, userId: string, id: string, now: number): PageRow {
  return db.transaction(() => {
    const row = loadPage(db, userId, id, { allowTrashed: true });
    if (row.trashed_at === null || row.trash_root_id !== id) throw new AppError('not_found', '垃圾桶裡沒有這個頁面。');
    const parent = row.parent_id ? db.get<PageRow>('SELECT * FROM pages WHERE id = ? AND user_id = ?', row.parent_id, userId) : undefined;
    // A row only exists inside its database; detaching it to the root would leave it unreachable.
    if (row.kind === 'row' && (!parent || parent.trashed_at !== null)) throw new AppError('conflict', '請先還原這筆資料所屬的資料庫。');
    const parentId = parent && parent.trashed_at === null ? parent.id : null;
    db.run('UPDATE pages SET trashed_at = NULL, trash_root_id = NULL, updated_at = ? WHERE trash_root_id = ?', now, id);
    const position = positionAt(db, userId, parentId, Number.MAX_SAFE_INTEGER, id);
    db.run('UPDATE pages SET parent_id = ?, position = ? WHERE id = ?', parentId, position, id);
    return loadPage(db, userId, id);
  });
}

export function deleteTrashed(db: Db, userId: string, id: string): number {
  return db.transaction(() => {
    const row = loadPage(db, userId, id, { allowTrashed: true });
    if (row.trashed_at === null || row.trash_root_id !== id) throw new AppError('not_found', '垃圾桶裡沒有這個頁面。');
    return db.run('DELETE FROM pages WHERE trash_root_id = ? AND user_id = ?', id, userId).changes;
  });
}

export function emptyTrash(db: Db, userId: string): number {
  return db.run('DELETE FROM pages WHERE user_id = ? AND trashed_at IS NOT NULL', userId).changes;
}

/** Deep copy of a page and its subtree, placed right after the original. */
export function duplicatePage(db: Db, userId: string, id: string, now: number): PageRow {
  return db.transaction(() => {
    const source = loadPage(db, userId, id);
    if (source.kind !== 'page') throw new AppError('bad_request', '目前只能複製一般頁面。');
    const copy = (row: PageRow, parentId: string | null, position: number): string => {
      const newId = crypto.randomUUID();
      db.run(`INSERT INTO pages (id, user_id, parent_id, kind, position, title, icon, cover_file_id, cover_preset, cover_position, content, content_text, full_width, created_at, updated_at)
              VALUES (?, ?, ?, 'page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId, userId, parentId, position, row.title, row.icon, row.cover_file_id, row.cover_preset, row.cover_position, JSON.stringify(stripAnnotationAnchors(JSON.parse(row.content) as unknown[])), row.content_text, row.full_width, now, now);
      const children = db.all<PageRow>("SELECT * FROM pages WHERE parent_id = ? AND user_id = ? AND trashed_at IS NULL AND kind = 'page' ORDER BY position", row.id, userId);
      children.forEach((child, i) => copy(child, newId, (i + 1) * GAP));
      return newId;
    };
    const list = siblings(db, userId, source.parent_id);
    const index = list.findIndex(sibling => sibling.id === id) + 1;
    const newId = copy({ ...source, title: source.title ? `${source.title}（副本）` : '' }, source.parent_id, positionAt(db, userId, source.parent_id, index));
    return loadPage(db, userId, newId);
  });
}

export function listVersions(db: Db, userId: string, id: string): VersionDto[] {
  loadPage(db, userId, id, { allowTrashed: true });
  return db.all<{ id: string; version: number; title: string; reason: string; created_at: number; size: number }>(
    'SELECT id, version, title, reason, created_at, LENGTH(content) AS size FROM page_versions WHERE page_id = ? ORDER BY version DESC', id)
    .map(row => ({ id: row.id, version: row.version, title: row.title, reason: row.reason, createdAt: row.created_at, size: Number(row.size) }));
}

export function getVersion(db: Db, userId: string, id: string, versionId: string): { title: string; content: Block[]; version: number } {
  loadPage(db, userId, id, { allowTrashed: true });
  const row = db.get<{ title: string; content: string; version: number }>('SELECT title, content, version FROM page_versions WHERE id = ? AND page_id = ?', versionId, id);
  if (!row) throw new AppError('not_found', '找不到這個版本。');
  return { title: row.title, content: JSON.parse(row.content) as Block[], version: row.version };
}

export function restoreVersion(db: Db, userId: string, id: string, versionId: string, expectedVersion: number, now: number): PageHeadDto {
  return db.transaction(() => {
    const snapshot = getVersion(db, userId, id, versionId);
    const head = updateContent(db, userId, id, snapshot.content, expectedVersion, now, 'restore');
    db.run('UPDATE pages SET title = ? WHERE id = ?', snapshot.title, id);
    return { ...head, title: snapshot.title };
  });
}
