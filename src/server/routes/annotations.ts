import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody } from './validate.ts';
import { expectedVersion } from './pages.ts';
import { changeAnnotationSchema, createAnnotationSchema } from '../../shared/annotations.ts';
import * as annotations from '../services/annotations.ts';

export function annotationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  const context = (c: Context<AppEnv>) => {
    const { db, now } = c.get('deps'); const userId = c.get('auth')!.user.id; const pageId = c.req.param('pageId')!;
    // Someone else's page is "not found" before anything about the request itself is examined.
    annotations.assertPage(db, userId, pageId);
    return { db, now: now(), userId, pageId };
  };
  app.get('/:pageId/annotations', c => {
    const { db, userId, pageId } = context(c);
    return c.json({ annotations: annotations.listAnnotations(db, userId, pageId) });
  });
  app.post('/:pageId/annotations', async c => {
    const { db, userId, pageId, now } = context(c);
    const input = await parseBody(c, createAnnotationSchema);
    return c.json({ annotation: annotations.createAnnotation(db, userId, pageId, input, now) }, 201);
  });
  app.patch('/:pageId/annotations/:id', async c => {
    const { db, userId, pageId, now } = context(c);
    const input = await parseBody(c, changeAnnotationSchema);
    return c.json({ annotation: annotations.changeAnnotation(db, userId, pageId, c.req.param('id'), input, expectedVersion(c), now) });
  });
  app.delete('/:pageId/annotations/:id', c => {
    const { db, userId, pageId } = context(c);
    const version = expectedVersion(c);
    annotations.deleteAnnotation(db, userId, pageId, c.req.param('id'), version);
    return c.body(null, 204);
  });
  return app;
}
