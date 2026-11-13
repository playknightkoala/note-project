import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { pageIdSchema } from '../../shared/api.ts';
import { accountRoleSchema, memberAddSchema, memberRoleSchema, openLinkSchema, shareScopeSchema } from '../../shared/shares.ts';
import type { OpenedLinkDto, SharesDto, ShareStateDto } from '../../shared/shares.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { parseBody } from './validate.ts';
import * as shares from '../services/shares.ts';
import { openLink } from '../services/access.ts';

const context = (c: Context<AppEnv>) => ({ db: c.get('deps').db, userId: c.get('auth')!.user.id, now: c.get('deps').now() });
const uuid = (value: string | undefined): string => { if (!value || !pageIdSchema.safeParse(value).success) throw new AppError('not_found'); return value; };
/** Who opened a page to whom, for the operator's log. The link's token is a credential and is never part of it. */
const record = (c: Context<AppEnv>, message: string, fields: Record<string, unknown>): void => c.get('deps').logger.info(message, { userId: c.get('auth')!.user.id, ...fields });

/** Managing a page's share, mounted next to the page routes. Every handler passes the caller's own id: owner only. */
export function pageShareRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/:id/share', c => { const { db, userId } = context(c); return c.json<ShareStateDto>(shares.shareState(db, userId, uuid(c.req.param('id')))); });
  app.put('/:id/share', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, shareScopeSchema);
    const state = shares.setScope(db, userId, uuid(c.req.param('id')), input.scope, now);
    record(c, 'share scope set', { pageId: c.req.param('id'), scope: input.scope });
    return c.json<ShareStateDto>(state);
  });
  app.delete('/:id/share', c => {
    const { db, userId } = context(c);
    shares.removeShare(db, userId, uuid(c.req.param('id')));
    record(c, 'share removed', { pageId: c.req.param('id') });
    return c.body(null, 204);
  });
  app.post('/:id/share/link', c => {
    const { db, userId, now } = context(c);
    const state = shares.enableLink(db, userId, uuid(c.req.param('id')), now);
    record(c, 'public link enabled', { pageId: c.req.param('id') });
    return c.json<ShareStateDto>(state);
  });
  app.delete('/:id/share/link', c => {
    const { db, userId, now } = context(c);
    const state = shares.disableLink(db, userId, uuid(c.req.param('id')), now);
    record(c, 'public link disabled', { pageId: c.req.param('id') });
    return c.json<ShareStateDto>(state);
  });
  app.put('/:id/share/account-link', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, accountRoleSchema);
    const state = shares.setAccountRole(db, userId, uuid(c.req.param('id')), input.role, now);
    record(c, 'public link role for accounts set', { pageId: c.req.param('id'), role: input.role });
    return c.json<ShareStateDto>(state);
  });
  app.put('/:id/share/members', async c => {
    const { db, userId, now } = context(c);
    const pageId = uuid(c.req.param('id'));
    const input = await parseBody(c, memberAddSchema);
    // Adding by address tells whether an account exists; the limit keeps that from being used to list accounts.
    const deps = c.get('deps');
    const limited = deps.rateLimiter.hit(`share-member:${userId}`, 30, 60 * 60_000, now);
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    const state = shares.setMember(db, userId, pageId, input.email, input.role, now);
    record(c, 'share member set', { pageId, memberId: state.share?.members.find(member => member.email === input.email)?.userId, role: input.role });
    return c.json<ShareStateDto>(state);
  });
  app.patch('/:id/share/members/:userId', async c => {
    const { db, userId, now } = context(c);
    const input = await parseBody(c, memberRoleSchema);
    const state = shares.changeMember(db, userId, uuid(c.req.param('id')), uuid(c.req.param('userId')), input.role, now);
    record(c, 'share member set', { pageId: c.req.param('id'), memberId: c.req.param('userId'), role: input.role });
    return c.json<ShareStateDto>(state);
  });
  app.delete('/:id/share/members/:userId', c => {
    const { db, userId, now } = context(c);
    const state = shares.changeMember(db, userId, uuid(c.req.param('id')), uuid(c.req.param('userId')), null, now);
    record(c, 'share member removed', { pageId: c.req.param('id'), memberId: c.req.param('userId') });
    return c.json<ShareStateDto>(state);
  });
  return app;
}

/** What I share and what is shared with me. */
export function shareRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);
  app.get('/', c => { const { db, userId } = context(c); return c.json<SharesDto>({ outgoing: shares.outgoingShares(db, userId), incoming: shares.incomingShares(db, userId) }); });
  // A signed-in account opens a public link: where the link gives accounts a role, this is what grants it.
  app.post('/open', async c => {
    const { db, userId, now } = context(c);
    const deps = c.get('deps');
    const limited = deps.rateLimiter.hit(`share-open:${userId}`, 120, 60_000, now);
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    const input = await parseBody(c, openLinkSchema);
    return c.json<OpenedLinkDto>({ pageId: db.transaction(() => openLink(db, userId, input.token, input.pageId, now)) });
  });
  app.delete('/incoming/:pageId', c => { const { db, userId } = context(c); shares.leaveShare(db, userId, uuid(c.req.param('pageId'))); return c.body(null, 204); });
  return app;
}
