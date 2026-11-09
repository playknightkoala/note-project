import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { loadPage } from '../services/pages.ts';
import { parseBody } from './validate.ts';
import { expectedVersion } from './pages.ts';
import { changeAnnotationSchema, createAnnotationSchema } from '../../shared/annotations.ts';
import type { Annotation } from '../../shared/annotations.ts';
import { AppError } from '../../shared/errors.ts';

interface AnnotationRow {
  id: string; quote: string; block_ids: string; messages: string; reactions: string;
  resolved: number; version: number; created_at: number; updated_at: number;
}
const dto = (row: AnnotationRow): Annotation => ({ id: row.id, quote: row.quote, blockIds: JSON.parse(row.block_ids) as string[],
  messages: JSON.parse(row.messages) as Annotation['messages'], reactions: JSON.parse(row.reactions) as string[], resolved: !!row.resolved,
  version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });

export function annotationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  const context = (c: Context<AppEnv>) => {
    const { db, now } = c.get('deps'); const userId = c.get('auth')!.user.id; const pageId = c.req.param('pageId')!;
    const page = loadPage(db, userId, pageId);
    if (page.kind === 'database') throw new AppError('not_found');
    return { db, now: now(), userId, pageId };
  };
  app.get('/:pageId/annotations', c => {
    const { db, userId, pageId } = context(c);
    return c.json({ annotations: db.all<AnnotationRow>('SELECT * FROM page_annotations WHERE user_id = ? AND page_id = ? ORDER BY created_at, id', userId, pageId).map(dto) });
  });
  app.post('/:pageId/annotations', async c => {
    const { db, userId, pageId, now } = context(c);
    const input = await parseBody(c, createAnnotationSchema);
    const id = crypto.randomUUID();
    return db.transaction(() => {
      const count = db.get<{ n: number }>('SELECT count(*) AS n FROM page_annotations WHERE user_id = ? AND page_id = ?', userId, pageId)!.n;
      if (count >= 500) throw new AppError('bad_request', '每頁最多 500 則選取範圍討論。');
      db.run(`INSERT INTO page_annotations (id, page_id, user_id, quote, block_ids, messages, reactions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, pageId, userId, input.quote, JSON.stringify(input.blockIds),
        JSON.stringify(input.text ? [{ id: crypto.randomUUID(), text: input.text, createdAt: now }] : []), JSON.stringify(input.emoji ? [input.emoji] : []), now, now);
      return c.json({ annotation: dto(db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ? AND user_id = ?', id, userId)!) }, 201);
    });
  });
  app.patch('/:pageId/annotations/:id', async c => {
    const { db, userId, pageId, now } = context(c);
    const input = await parseBody(c, changeAnnotationSchema); const version = expectedVersion(c);
    return db.transaction(() => {
      const row = db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', c.req.param('id'), pageId, userId);
      if (!row) throw new AppError('not_found');
      if (version !== row.version) throw new AppError('version_conflict', '留言已在其他分頁更新，請重新載入後再試。');
      const annotation = dto(row);
      if (input.action === 'comment') {
        if (annotation.messages.length >= 100) throw new AppError('bad_request', '每則討論最多 100 則留言。');
        annotation.messages.push({ id: crypto.randomUUID(), text: input.text, createdAt: now });
      } else if (input.action === 'reaction') {
        annotation.reactions = annotation.reactions.includes(input.emoji) ? annotation.reactions.filter(emoji => emoji !== input.emoji) : [...annotation.reactions, input.emoji];
      } else annotation.resolved = input.resolved;
      db.run('UPDATE page_annotations SET messages = ?, reactions = ?, resolved = ?, version = version + 1, updated_at = ? WHERE id = ? AND page_id = ? AND user_id = ? AND version = ?',
        JSON.stringify(annotation.messages), JSON.stringify(annotation.reactions), Number(annotation.resolved), now, row.id, pageId, userId, version);
      return c.json({ annotation: { ...annotation, version: version + 1, updatedAt: now } });
    });
  });
  app.delete('/:pageId/annotations/:id', c => {
    const { db, userId, pageId } = context(c);
    const version = expectedVersion(c);
    return db.transaction(() => {
      const row = db.get<AnnotationRow>('SELECT * FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ?', c.req.param('id'), pageId, userId);
      if (!row) throw new AppError('not_found');
      if (version !== row.version) throw new AppError('version_conflict', '留言已在其他分頁更新，請重新載入後再試。');
      db.run('DELETE FROM page_annotations WHERE id = ? AND page_id = ? AND user_id = ? AND version = ?', row.id, pageId, userId, version);
      return c.body(null, 204);
    });
  });
  return app;
}
