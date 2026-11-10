import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { pageIdSchema } from '../../shared/api.ts';
import type { PublicPageDto, PublicShareDto } from '../../shared/shares.ts';
import { publicContent, publicFileUrl } from '../../shared/shares.ts';
import { clientIp } from '../auth/middleware.ts';
import * as pages from '../services/pages.ts';
import * as databases from '../services/databases.ts';
import { linkChain, resolveLink, scopePages } from '../services/access.ts';
import type { LinkShare } from '../services/access.ts';
import { loadLinkFile } from '../services/storage.ts';
import { sendFile } from './files.ts';

/** Per address; generous enough for a page full of pictures, far too low to try addresses at random. */
const LIMIT = 600, WINDOW_MS = 60_000;

/**
 * What the holder of a public link may read, without an account: GET only, nothing here writes. An unknown or
 * switched-off address and a page the link does not reach are answered identically ("not found"). Discussions are
 * never served, and page content is cleaned of everything that points outside the share.
 */
export function publicRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const deps = c.get('deps');
    const limited = deps.rateLimiter.hit(`public:${clientIp(c)}`, LIMIT, WINDOW_MS, deps.now());
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    c.header('X-Robots-Tag', 'noindex, nofollow');
    await next();
  });
  const link = (c: Context<AppEnv>): LinkShare => resolveLink(c.get('deps').db, c.req.param('token') ?? '');

  app.get('/:token', c => {
    const { db } = c.get('deps');
    const share = link(c);
    const tree = scopePages(db, share.ownerId, share.pageId, share.scope).filter(page => page.kind !== 'row')
      .map(page => ({ id: page.id, parentId: page.id === share.pageId ? null : page.parent_id, kind: page.kind, title: page.title, icon: page.icon }));
    return c.json<PublicShareDto>({ rootId: share.pageId, scope: share.scope, tree });
  });

  app.get('/:token/pages/:id', c => {
    const { db } = c.get('deps');
    const share = link(c), id = c.req.param('id');
    if (!pageIdSchema.safeParse(id).success) throw new AppError('not_found', '找不到頁面。');
    const breadcrumbs = linkChain(db, share, id);
    const row = pages.loadPage(db, share.ownerId, id);
    const reachable = new Set(scopePages(db, share.ownerId, share.pageId, share.scope).map(page => page.id));
    const dto = pages.toPageDto(row);
    const cover = row.cover_file_id ? publicFileUrl(share.token, row.cover_file_id) : row.cover_preset;
    const result: PublicPageDto = {
      page: { id: row.id, kind: row.kind, databaseId: row.database_id, title: row.title, icon: row.icon, coverUrl: cover, coverPosition: row.cover_position,
        fullWidth: dto.fullWidth, content: publicContent(dto.content, share.token, reachable), updatedAt: row.updated_at },
      breadcrumbs,
    };
    if (row.kind === 'database') {
      const snapshot = databases.snapshot(db, share.ownerId, id);
      result.database = { meta: snapshot.meta, rows: snapshot.rows };
    }
    if (row.kind === 'row' && row.database_id) {
      result.row = { values: databases.getRow(db, share.ownerId, id).values, properties: databases.getDatabase(db, share.ownerId, row.database_id).properties };
    }
    return c.json(result);
  });

  app.get('/:token/files/:id/:name?', c => {
    const row = loadLinkFile(c.get('deps').db, link(c), c.req.param('id'));
    return sendFile(c, row, { 'Cache-Control': 'private, no-cache' });
  });
  return app;
}
