import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { pageIdSchema } from '../../shared/api.ts';
import { accountRoleSchema, memberAddSchema, memberRoleSchema, shareScopeSchema } from '../../shared/shares.ts';
import type { SharesDto, ShareStateDto } from '../../shared/shares.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody } from './validate.ts';
import * as shares from '../services/shares.ts';

const context = (c: Context<AppEnv>) => ({ db: c.get('deps').db, userId: c.get('auth')!.user.id, now: c.get('deps').now() });
const uuid = (value: string | undefined): string => { if (!value || !pageIdSchema.safeParse(value).success) throw new AppError('not_found'); return value; };

/** Managing a page's share, mounted next to the page routes. Every handler passes the caller's own id: owner only. */
export function pageShareRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/:id/share', c => { const { db, userId } = context(c); return c.json<ShareStateDto>(shares.shareState(db, userId, uuid(c.req.param('id')))); });
  app.put('/:id/share', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, shareScopeSchema);
    return c.json<ShareStateDto>(shares.setScope(db, userId, uuid(c.req.param('id')), input.scope, now));
  });
  app.delete('/:id/share', c => { const { db, userId } = context(c); shares.removeShare(db, userId, uuid(c.req.param('id'))); return c.body(null, 204); });
  app.post('/:id/share/link', c => { const { db, userId, now } = context(c); return c.json<ShareStateDto>(shares.enableLink(db, userId, uuid(c.req.param('id')), now)); });
  app.delete('/:id/share/link', c => { const { db, userId, now } = context(c); return c.json<ShareStateDto>(shares.disableLink(db, userId, uuid(c.req.param('id')), now)); });
  app.put('/:id/share/account-link', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, accountRoleSchema);
    return c.json<ShareStateDto>(shares.setAccountRole(db, userId, uuid(c.req.param('id')), input.role, now));
  });
  app.put('/:id/share/members', async c => {
    const { db, userId, now } = context(c);
    const pageId = uuid(c.req.param('id'));
    const input = await parseBody(c, memberAddSchema);
    // Adding by address tells whether an account exists; the limit keeps that from being used to list accounts.
    const deps = c.get('deps');
    const limited = deps.rateLimiter.hit(`share-member:${userId}`, 30, 60 * 60_000, now);
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    return c.json<ShareStateDto>(shares.setMember(db, userId, pageId, input.email, input.role, now));
  });
  app.patch('/:id/share/members/:userId', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, memberRoleSchema);
    return c.json<ShareStateDto>(shares.changeMember(db, userId, uuid(c.req.param('id')), uuid(c.req.param('userId')), input.role, now));
  });
  app.delete('/:id/share/members/:userId', c => {
    const { db, userId, now } = context(c);
    return c.json<ShareStateDto>(shares.changeMember(db, userId, uuid(c.req.param('id')), uuid(c.req.param('userId')), null, now));
  });
  return app;
}

/** What I share and what is shared with me. */
export function shareRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/', c => { const { db, userId } = context(c); return c.json<SharesDto>({ outgoing: shares.outgoingShares(db, userId), incoming: shares.incomingShares(db, userId) }); });
  app.delete('/incoming/:pageId', c => { const { db, userId } = context(c); shares.leaveShare(db, userId, uuid(c.req.param('pageId'))); return c.body(null, 204); });
  return app;
}
