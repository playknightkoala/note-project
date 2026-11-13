import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody } from './validate.ts';
import { expectedVersion } from './pages.ts';
import { changeAnnotationSchema, createAnnotationSchema } from '../../shared/annotations.ts';
import * as annotations from '../services/annotations.ts';
import { requireAccess } from '../services/access.ts';

/** Whoever may read a page (its owner and the members it is shared with, whatever their role) may discuss it. */
export function annotationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  const context = (c: Context<AppEnv>) => {
    const { db, now } = c.get('deps'); const userId = c.get('auth')!.user.id; const pageId = c.req.param('pageId')!;
    // Someone else's unshared page is "not found" before anything about the request itself is examined.
    const { ownerId, role } = requireAccess(db, userId, pageId, 'comment');
    annotations.assertPage(db, ownerId, pageId);
    return { db, now: now(), userId, ownerId, pageId, moderator: role !== 'viewer' };
  };
  app.get('/:pageId/annotations', c => {
    const { db, userId, ownerId, pageId } = context(c);
    return c.json({ annotations: annotations.listAnnotations(db, ownerId, pageId, userId) });
  });
  // Access is settled again once the body has arrived: a share can end while a comment is on its way.
  app.post('/:pageId/annotations', async c => {
    context(c);
    const input = await parseBody(c, createAnnotationSchema);
    const { db, userId, ownerId, pageId, now } = context(c);
    return c.json({ annotation: annotations.createAnnotation(db, ownerId, pageId, input, now, userId) }, 201);
  });
  app.patch('/:pageId/annotations/:id', async c => {
    context(c);
    const input = await parseBody(c, changeAnnotationSchema);
    const { db, userId, ownerId, pageId, now, moderator } = context(c);
    return c.json({ annotation: annotations.changeAnnotation(db, ownerId, pageId, c.req.param('id'), input, expectedVersion(c), now, userId, moderator) });
  });
  app.delete('/:pageId/annotations/:id', c => {
    const { db, userId, ownerId, pageId } = context(c);
    const version = expectedVersion(c);
    annotations.deleteAnnotation(db, ownerId, pageId, c.req.param('id'), version, userId);
    return c.body(null, 204);
  });
  return app;
}
