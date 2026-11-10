import type { Db } from '../db/driver.ts';
import type { Annotation, ChangeAnnotation } from '../../shared/annotations.ts';
import { AppError } from '../../shared/errors.ts';
import { loadPage } from './pages.ts';

interface AnnotationRow {
  id: string; page_id: string; user_id: string; quote: string; block_ids: string; messages: string; reactions: string;
  resolved: number; version: number; created_at: number; updated_at: number;
}
const dto = (row: AnnotationRow): Annotation => ({ id: row.id, quote: row.quote, blockIds: JSON.parse(row.block_ids) as string[],
  messages: JSON.parse(row.messages) as Annotation['messages'], reactions: JSON.parse(row.reactions) as string[], resolved: !!row.resolved,
  version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });

const MAX_PER_PAGE = 500, MAX_MESSAGES = 100;
const STALE = '留言已在其他分頁更新，請重新載入後再試。';

/** Discussions belong to notes and rows; a foreign, missing or database page is "not found". */
export function assertPage(db: Db, userId: string, pageId: string): void {
  if (loadPage(db, userId, pageId).kind === 'database') throw new AppError('not_found');
}
const find = (db: Db, userId: string, pageId: string, id: string) =>
  db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', id, pageId, userId);

export function listAnnotations(db: Db, userId: string, pageId: string): Annotation[] {
  assertPage(db, userId, pageId);
  return db.all<AnnotationRow>('SELECT * FROM page_annotations WHERE user_id = ? AND page_id = ? ORDER BY created_at, id', userId, pageId).map(dto);
}

/** The discussion as it is now, or undefined once it has been deleted. */
export function getAnnotation(db: Db, userId: string, pageId: string, id: string): Annotation | undefined {
  const row = find(db, userId, pageId, id);
  return row && dto(row);
}

export interface NewAnnotation {
  quote: string; blockIds: string[]; text?: string | undefined; emoji?: string | undefined;
  /** Chosen by the client for a discussion started offline: repeating the request returns the first one. */
  id?: string; messageId?: string;
  /** When the comment was written; never later than the server's clock. */
  at?: number;
}
export function createAnnotation(db: Db, userId: string, pageId: string, input: NewAnnotation, now: number): Annotation {
  return db.transaction(() => {
    assertPage(db, userId, pageId);
    if (input.id) {
      const existing = db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ?', input.id);
      if (existing) {
        if (existing.user_id !== userId || existing.page_id !== pageId) throw new AppError('conflict', '討論識別碼無法使用。');
        return dto(existing);
      }
    }
    const count = db.get<{ n: number }>('SELECT count(*) AS n FROM page_annotations WHERE user_id = ? AND page_id = ?', userId, pageId)!.n;
    if (count >= MAX_PER_PAGE) throw new AppError('bad_request', `每頁最多 ${MAX_PER_PAGE} 則選取範圍討論。`);
    const id = input.id ?? crypto.randomUUID(), at = Math.min(input.at ?? now, now);
    db.run(`INSERT INTO page_annotations (id, page_id, user_id, quote, block_ids, messages, reactions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, pageId, userId, input.quote, JSON.stringify(input.blockIds),
      JSON.stringify(input.text ? [{ id: input.messageId ?? crypto.randomUUID(), text: input.text, createdAt: at }] : []), JSON.stringify(input.emoji ? [input.emoji] : []), at, now);
    return dto(find(db, userId, pageId, id)!);
  });
}

/**
 * `version` is the `If-Match` of an online edit. Changes made offline pass null instead: a comment is appended, a
 * reaction is switched on or off and the resolved flag is set, none of which can overwrite anybody's text.
 */
export function changeAnnotation(db: Db, userId: string, pageId: string, id: string, input: ChangeAnnotation & { messageId?: string; at?: number; on?: boolean }, version: number | null, now: number): Annotation {
  return db.transaction(() => {
    assertPage(db, userId, pageId);
    const row = find(db, userId, pageId, id);
    if (!row) throw new AppError('not_found', '這則討論已被刪除。');
    if (version !== null && version !== row.version) throw new AppError('version_conflict', STALE);
    const annotation = dto(row);
    if (input.action === 'comment') {
      if (input.messageId && annotation.messages.some(message => message.id === input.messageId)) return annotation;
      if (annotation.messages.length >= MAX_MESSAGES) throw new AppError('bad_request', `每則討論最多 ${MAX_MESSAGES} 則留言。`);
      annotation.messages.push({ id: input.messageId ?? crypto.randomUUID(), text: input.text, createdAt: Math.min(input.at ?? now, now) });
    } else if (input.action === 'reaction') {
      const on = input.on ?? !annotation.reactions.includes(input.emoji);
      annotation.reactions = on ? [...annotation.reactions.filter(emoji => emoji !== input.emoji), input.emoji] : annotation.reactions.filter(emoji => emoji !== input.emoji);
    } else annotation.resolved = input.resolved;
    db.run('UPDATE page_annotations SET messages = ?, reactions = ?, resolved = ?, version = version + 1, updated_at = ? WHERE id = ? AND page_id = ? AND user_id = ?',
      JSON.stringify(annotation.messages), JSON.stringify(annotation.reactions), Number(annotation.resolved), now, row.id, pageId, userId);
    return { ...annotation, version: row.version + 1, updatedAt: now };
  });
}

/** Returns false when the discussion was already gone (only possible without a `version`). */
export function deleteAnnotation(db: Db, userId: string, pageId: string, id: string, version: number | null): boolean {
  return db.transaction(() => {
    assertPage(db, userId, pageId);
    const row = find(db, userId, pageId, id);
    if (!row) { if (version === null) return false; throw new AppError('not_found'); }
    if (version !== null && version !== row.version) throw new AppError('version_conflict', STALE);
    db.run('DELETE FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', row.id, pageId, userId);
    return true;
  });
}

/** One entry per page that has discussions; the stamp changes whenever any of them does. */
export function annotationStamps(db: Db, userId: string): { pageId: string; stamp: string }[] {
  return db.all<{ page_id: string; n: number; v: number; u: number; c: number }>(`SELECT a.page_id, COUNT(*) AS n, SUM(a.version) AS v, MAX(a.updated_at) AS u, MAX(a.created_at) AS c
    FROM page_annotations a JOIN pages p ON p.id = a.page_id AND p.user_id = a.user_id AND p.trashed_at IS NULL WHERE a.user_id = ? GROUP BY a.page_id`, userId)
    .map(row => ({ pageId: row.page_id, stamp: [row.n, row.v, row.u, row.c].join('.') }));
}
