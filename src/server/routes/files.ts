import { Hono } from 'hono';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { requestBodyLimit } from './validate.ts';
import { blobPath, deleteFile, fileDto, loadFileFor, saveFile } from '../services/storage.ts';
import type { FileRow } from '../services/storage.ts';
import { requireAccess } from '../services/access.ts';
import type { Context } from 'hono';
import { fileHeaders } from '../../shared/files.ts';
import { pageIdSchema } from '../../shared/api.ts';

/** Boundary lines and part headers around the single `file` field. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

/** Streams a stored file with the headers its type calls for (only four image types are ever shown inline). */
export function sendFile(c: Context<AppEnv>, row: FileRow, extra: Record<string, string>): Response {
  const etag = `"${row.sha256}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag, ...extra });
  const path = blobPath(c.get('deps').config.dataDir, row.sha256);
  let size: number;
  try { size = statSync(path).size; } catch { throw new AppError('not_found', '檔案內容遺失。'); }
  const headers: Record<string, string> = { ...fileHeaders(row.mime, row.original_name), 'Content-Length': String(size), ETag: etag, ...extra };
  if (c.req.method === 'HEAD') return c.body(null, 200, headers);
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, headers);
}

export function fileRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);

  // Runs after authentication, and also counts bodies sent without a Content-Length (chunked), so an oversized
  // upload is cut off at the limit instead of being buffered whole.
  app.post('/', async (c, next) => {
    const { maxUploadBytes } = c.get('deps').config;
    return requestBodyLimit(maxUploadBytes + MULTIPART_OVERHEAD_BYTES, `檔案超過 ${Math.round(maxUploadBytes / 1024 / 1024)} MB。`)(c, next);
  }, async c => {
    const deps = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const limited = deps.rateLimiter.hit(`upload:${userId}`, 60, 60_000, deps.now());
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw new AppError('bad_request', '請以 multipart/form-data 上傳檔案。'); }
    const part = form.get('file');
    if (!(part instanceof File)) throw new AppError('bad_request', '缺少 file 欄位。');
    if (part.size > deps.config.maxUploadBytes) throw new AppError('payload_too_large', `檔案超過 ${Math.round(deps.config.maxUploadBytes / 1024 / 1024)} MB。`);
    // An id chosen by the client makes the upload repeatable: a file queued on a device may be sent more than once.
    const id = form.get('id');
    if (id !== null && (typeof id !== 'string' || !pageIdSchema.safeParse(id).success)) throw new AppError('bad_request', '檔案識別碼格式不正確。');
    // A file added to somebody else's page (edit access required) becomes the page owner's, so the page stays whole
    // whatever happens to the member's access or account later.
    const pageId = form.get('pageId');
    if (pageId !== null && (typeof pageId !== 'string' || !pageIdSchema.safeParse(pageId).success)) throw new AppError('bad_request', '頁面識別碼格式不正確。');
    const access = pageId ? requireAccess(deps.db, userId, pageId, 'edit') : undefined;
    const member = access && access.role !== 'owner';
    const bytes = new Uint8Array(await part.arrayBuffer());
    const row = saveFile(deps.db, deps.config.dataDir, member ? access.ownerId : userId,
      { bytes, originalName: part.name, declaredMime: part.type || undefined, ...(id ? { id } : {}), ...(member ? { uploadedBy: userId } : {}) }, deps.now());
    return c.json(fileDto(row), row.created ? 201 : 200);
  });

  app.get('/:id/:name?', c => {
    const deps = c.get('deps'), userId = c.get('auth')!.user.id;
    // `X-Notes-User` names who this answer is for: the service worker keeps a copy only for the account it serves.
    return sendFile(c, loadFileFor(deps.db, userId, c.req.param('id')), { 'Cache-Control': 'private, no-cache', 'X-Notes-User': userId });
  });

  app.delete('/:id', c => {
    const deps = c.get('deps');
    deleteFile(deps.db, deps.config.dataDir, c.get('auth')!.user.id, c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
