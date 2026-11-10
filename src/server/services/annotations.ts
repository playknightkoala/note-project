import type { Db } from '../db/driver.ts';
import type { Annotation, AnnotationAuthor, ChangeAnnotation } from '../../shared/annotations.ts';
import { AppError } from '../../shared/errors.ts';
import { loadPage } from './pages.ts';

/**
 * Discussions are stored with the page (`user_id` is the page's owner, which every query here carries). Whoever may
 * read the page may take part: `actorId` is the person acting, the owner when left out. Routes resolve the actor's
 * access before calling in.
 */
interface AnnotationRow {
  id: string; page_id: string; user_id: string; quote: string; block_ids: string; messages: string; reactions: string;
  resolved: number; version: number; created_at: number; updated_at: number; author_id: string | null; floating: number;
}
/** Records written before pages could be shared carry no author: they are the owner's. */
interface StoredMessage { id: string; text: string; createdAt: number; authorId?: string }
type StoredReaction = string | { emoji: string; userId: string };
const reactionsOf = (row: AnnotationRow) => (JSON.parse(row.reactions) as StoredReaction[]).map(item => typeof item === 'string' ? { emoji: item, userId: row.user_id } : item);
const messagesOf = (row: AnnotationRow) => JSON.parse(row.messages) as StoredMessage[];

function reader(db: Db, viewerId: string): (row: AnnotationRow) => Annotation {
  const names = new Map<string, string>();
  const author = (id: string): AnnotationAuthor => {
    if (!names.has(id)) names.set(id, db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', id)?.display_name ?? '已移除的帳號');
    return { id, name: names.get(id)! };
  };
  return row => {
    const reactions = reactionsOf(row), counts: Record<string, number> = {};
    for (const item of reactions) counts[item.emoji] = (counts[item.emoji] ?? 0) + 1;
    const startedBy = row.author_id ?? row.user_id;
    return { id: row.id, quote: row.quote, blockIds: JSON.parse(row.block_ids) as string[],
      messages: messagesOf(row).map(message => ({ id: message.id, text: message.text, createdAt: message.createdAt, author: author(message.authorId ?? row.user_id) })),
      reactions: Object.keys(counts), resolved: !!row.resolved, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      author: author(startedBy), mine: reactions.filter(item => item.userId === viewerId).map(item => item.emoji), counts,
      canDelete: viewerId === row.user_id || viewerId === startedBy, ...(row.floating ? { floating: true } : {}) };
  };
}

const MAX_PER_PAGE = 500, MAX_MESSAGES = 100;
/** What one person who does not own the page may add to it, so nobody can use up the page's allowance or bury a discussion in emoji. */
const MAX_PER_GUEST = 100, MAX_REACTIONS_EACH = 20;
/** A change made offline may arrive late, but not from an arbitrary past: as far back as a queued operation is kept. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const writtenAt = (at: number | undefined, now: number): number => Math.max(Math.min(at ?? now, now), now - MAX_AGE_MS);
const STALE = '留言已在其他分頁更新，請重新載入後再試。';

/** Discussions belong to notes and rows; a foreign, missing or database page is "not found". */
export function assertPage(db: Db, ownerId: string, pageId: string): void {
  if (loadPage(db, ownerId, pageId).kind === 'database') throw new AppError('not_found');
}
const find = (db: Db, ownerId: string, pageId: string, id: string) =>
  db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', id, pageId, ownerId);

export function listAnnotations(db: Db, ownerId: string, pageId: string, viewerId: string = ownerId): Annotation[] {
  assertPage(db, ownerId, pageId);
  return db.all<AnnotationRow>('SELECT * FROM page_annotations WHERE user_id = ? AND page_id = ? ORDER BY created_at, id', ownerId, pageId).map(reader(db, viewerId));
}

/** The discussion as it is now, or undefined once it has been deleted. */
export function getAnnotation(db: Db, ownerId: string, pageId: string, id: string, viewerId: string = ownerId): Annotation | undefined {
  const row = find(db, ownerId, pageId, id);
  return row && reader(db, viewerId)(row);
}

export interface NewAnnotation {
  quote: string; blockIds: string[]; text?: string | undefined; emoji?: string | undefined;
  /** Chosen by the client for a discussion started offline: repeating the request returns the first one. */
  id?: string; messageId?: string;
  /** When the comment was written; never later than the server's clock. */
  at?: number;
  /** Started by someone who cannot save the page: shown by its quote, the page itself is not touched. */
  floating?: boolean | undefined;
}

export function createAnnotation(db: Db, ownerId: string, pageId: string, input: NewAnnotation, now: number, actorId: string = ownerId): Annotation {
  return db.transaction(() => {
    assertPage(db, ownerId, pageId);
    const read = reader(db, actorId);
    if (input.id) {
      const existing = db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ?', input.id);
      if (existing) {
        if (existing.user_id !== ownerId || existing.page_id !== pageId) throw new AppError('conflict', '討論識別碼無法使用。');
        return read(existing);
      }
    }
    const count = db.get<{ n: number }>('SELECT count(*) AS n FROM page_annotations WHERE user_id = ? AND page_id = ?', ownerId, pageId)!.n;
    if (count >= MAX_PER_PAGE) throw new AppError('bad_request', `每頁最多 ${MAX_PER_PAGE} 則選取範圍討論。`);
    if (actorId !== ownerId) {
      const own = db.get<{ n: number }>('SELECT count(*) AS n FROM page_annotations WHERE user_id = ? AND page_id = ? AND author_id = ?', ownerId, pageId, actorId)!.n;
      if (own >= MAX_PER_GUEST) throw new AppError('bad_request', `在別人的頁面上，每人每頁最多發起 ${MAX_PER_GUEST} 則討論。`);
    }
    const id = input.id ?? crypto.randomUUID(), at = writtenAt(input.at, now);
    const messages: StoredMessage[] = input.text ? [{ id: input.messageId ?? crypto.randomUUID(), text: input.text, createdAt: at, authorId: actorId }] : [];
    const reactions: StoredReaction[] = input.emoji ? [{ emoji: input.emoji, userId: actorId }] : [];
    db.run(`INSERT INTO page_annotations (id, page_id, user_id, author_id, floating, quote, block_ids, messages, reactions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, pageId, ownerId, actorId === ownerId ? null : actorId, input.floating ? 1 : 0, input.quote, JSON.stringify(input.blockIds), JSON.stringify(messages), JSON.stringify(reactions), at, now);
    return read(find(db, ownerId, pageId, id)!);
  });
}

/**
 * `version` is the `If-Match` of an online edit. Changes made offline pass null instead: a comment is appended, a
 * reaction is switched on or off and the resolved flag is set, none of which can overwrite anybody's text.
 * A reaction is each person's own: switching it never touches somebody else's. Marking a discussion as resolved hides
 * it for everybody, so that is for the owner, members with edit access (`moderator`) and whoever started it.
 */
export function changeAnnotation(db: Db, ownerId: string, pageId: string, id: string, input: ChangeAnnotation & { messageId?: string; at?: number; on?: boolean }, version: number | null, now: number, actorId: string = ownerId, moderator = true): Annotation {
  return db.transaction(() => {
    assertPage(db, ownerId, pageId);
    const row = find(db, ownerId, pageId, id);
    if (!row) throw new AppError('not_found', '這則討論已被刪除。');
    if (version !== null && version !== row.version) throw new AppError('version_conflict', STALE);
    const read = reader(db, actorId);
    let messages = messagesOf(row), reactions = reactionsOf(row), resolved = !!row.resolved;
    if (input.action === 'comment') {
      if (input.messageId && messages.some(message => message.id === input.messageId)) return read(row);
      if (messages.length >= MAX_MESSAGES) throw new AppError('bad_request', `每則討論最多 ${MAX_MESSAGES} 則留言。`);
      messages = [...messages, { id: input.messageId ?? crypto.randomUUID(), text: input.text, createdAt: writtenAt(input.at, now), authorId: actorId }];
    } else if (input.action === 'reaction') {
      const has = reactions.some(item => item.emoji === input.emoji && item.userId === actorId);
      const on = input.on ?? !has;
      if (on === has && version === null) return read(row);
      reactions = reactions.filter(item => !(item.emoji === input.emoji && item.userId === actorId));
      if (on && reactions.filter(item => item.userId === actorId).length >= MAX_REACTIONS_EACH) throw new AppError('bad_request', `每人在一則討論最多 ${MAX_REACTIONS_EACH} 個表情反應。`);
      if (on) reactions.push({ emoji: input.emoji, userId: actorId });
    } else {
      if (!moderator && actorId !== (row.author_id ?? row.user_id)) throw new AppError('forbidden', '只有頁面擁有者、可編輯的成員或發起這則討論的人可以變更它的狀態。');
      resolved = input.resolved;
    }
    db.run('UPDATE page_annotations SET messages = ?, reactions = ?, resolved = ?, version = version + 1, updated_at = ? WHERE id = ? AND page_id = ? AND user_id = ?',
      JSON.stringify(messages), JSON.stringify(reactions), Number(resolved), now, row.id, pageId, ownerId);
    return read(find(db, ownerId, pageId, id)!);
  });
}

/**
 * Returns false when the discussion was already gone (only possible without a `version`). A whole discussion may be
 * deleted by the page's owner and by whoever started it.
 */
export function deleteAnnotation(db: Db, ownerId: string, pageId: string, id: string, version: number | null, actorId: string = ownerId): boolean {
  return db.transaction(() => {
    assertPage(db, ownerId, pageId);
    const row = find(db, ownerId, pageId, id);
    if (!row) { if (version === null) return false; throw new AppError('not_found'); }
    if (actorId !== ownerId && actorId !== row.author_id) throw new AppError('forbidden', '只有頁面擁有者或發起這則討論的人可以刪除它。');
    if (version !== null && version !== row.version) throw new AppError('version_conflict', STALE);
    db.run('DELETE FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', row.id, pageId, ownerId);
    return true;
  });
}

const STAMP = `SELECT a.page_id, COUNT(*) AS n, SUM(a.version) AS v, MAX(a.updated_at) AS u, MAX(a.created_at) AS c
    FROM page_annotations a JOIN pages p ON p.id = a.page_id AND p.user_id = a.user_id AND p.trashed_at IS NULL`;
interface StampRow { page_id: string; n: number; v: number; u: number; c: number }
const stamp = (row: StampRow) => ({ pageId: row.page_id, stamp: [row.n, row.v, row.u, row.c].join('.') });

/** One entry per page that has discussions; the stamp changes whenever any of them does. */
export function annotationStamps(db: Db, userId: string): { pageId: string; stamp: string }[] {
  return db.all<StampRow>(`${STAMP} WHERE a.user_id = ? GROUP BY a.page_id`, userId).map(stamp);
}
/** The same for a given set of pages, whoever owns them. The caller has established that the reader may see each. */
export function annotationStampsOf(db: Db, pageIds: string[]): { pageId: string; stamp: string }[] {
  const found: { pageId: string; stamp: string }[] = [];
  for (let index = 0; index < pageIds.length; index += 400) {
    const batch = pageIds.slice(index, index + 400);
    found.push(...db.all<StampRow>(`${STAMP} WHERE a.page_id IN (${batch.map(() => '?').join(',')}) GROUP BY a.page_id`, ...batch).map(stamp));
  }
  return found;
}
