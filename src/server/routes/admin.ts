import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { inviteCreateSchema, userUpdateSchema } from '../../shared/api.ts';
import { AppError } from '../../shared/errors.ts';
import { createInvite, listInvites, revokeInvite } from '../auth/invites.ts';
import { assertAdmin, requireAdmin, requireAuth, requireCsrf } from '../auth/middleware.ts';
import { deleteUserSessions } from '../auth/session.ts';
import { countActiveAdmins, findUserById, listUsersForAdmin } from '../services/users.ts';
import { parseBody } from './validate.ts';

export function adminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireAdmin, requireCsrf);

  app.get('/users', c => c.json({ users: listUsersForAdmin(c.get('deps').db) }));

  app.patch('/users/:id', async c => {
    const deps = c.get('deps');
    const input = await parseBody(c, userUpdateSchema);
    // The role as it is now that the body has arrived: an administrator demoted meanwhile no longer acts as one.
    assertAdmin(c);
    const auth = c.get('auth')!;
    const target = findUserById(deps.db, c.req.param('id'));
    if (!target) throw new AppError('not_found');
    if (target.id === auth.user.id && (input.disabled === true || input.role === 'user')) throw new AppError('conflict', '不能停用或降級自己的帳號。');
    deps.db.transaction(() => {
      const now = deps.now();
      if (input.role !== undefined && input.role !== target.role) {
        if (target.role === 'admin' && target.disabled_at === null && countActiveAdmins(deps.db) <= 1) throw new AppError('conflict', '至少要保留一位管理者。');
        deps.db.run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', input.role, now, target.id);
      }
      if (input.disabled !== undefined) {
        if (input.disabled && target.role === 'admin' && target.disabled_at === null && countActiveAdmins(deps.db) <= 1) throw new AppError('conflict', '至少要保留一位管理者。');
        deps.db.run('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?', input.disabled ? now : null, now, target.id);
        if (input.disabled) deleteUserSessions(deps.db, target.id);
      }
    });
    deps.logger.info('user changed by administrator', { actorId: auth.user.id, userId: target.id, ...(input.role !== undefined ? { role: input.role } : {}), ...(input.disabled !== undefined ? { disabled: input.disabled } : {}) });
    const user = listUsersForAdmin(deps.db).find(u => u.id === target.id);
    return c.json({ user });
  });

  app.get('/invites', c => c.json({ invites: listInvites(c.get('deps').db) }));

  app.post('/invites', async c => {
    const deps = c.get('deps');
    const input = await parseBody(c, inviteCreateSchema);
    assertAdmin(c);
    const { code, invite } = createInvite(deps.db, c.get('auth')!.user.id, deps.now(), input.expiresInHours, input.note);
    // The code itself is shown to the administrator once and never written anywhere else.
    deps.logger.info('invite created', { actorId: c.get('auth')!.user.id, inviteId: invite.id });
    return c.json({ code, invite }, 201);
  });

  app.delete('/invites/:id', c => {
    const deps = c.get('deps');
    if (!revokeInvite(deps.db, c.req.param('id'), deps.now())) throw new AppError('not_found', '邀請碼不存在或已使用。');
    deps.logger.info('invite revoked', { actorId: c.get('auth')!.user.id, inviteId: c.req.param('id') });
    return c.body(null, 204);
  });

  return app;
}
