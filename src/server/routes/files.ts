import { Hono } from 'hono';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { requireAuth, requireCsrf } from '../auth/middleware.ts';
import { blobPath, deleteFile, fileDto, loadFile, saveFile, servesInline } from '../services/storage.ts';

export function fileRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth, requireCsrf);

  app.post('/', async c => {
    const deps = c.get('deps');
    const userId = c.get('auth')!.user.id;
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > deps.config.maxUploadBytes + 4096) throw new AppError('payload_too_large', `檔案超過 ${Math.round(deps.config.maxUploadBytes / 1024 / 1024)} MB。`);
    const limited = deps.rateLimiter.hit(`upload:${userId}`, 60, 60_000, deps.now());
    if (!limited.allowed) throw new AppError('rate_limited', undefined, { retryAfterSeconds: limited.retryAfterSeconds });
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw new AppError('bad_request', '請以 multipart/form-data 上傳檔案。'); }
    const part = form.get('file');
    if (!(part instanceof File)) throw new AppError('bad_request', '缺少 file 欄位。');
    if (part.size > deps.config.maxUploadBytes) throw new AppError('payload_too_large', `檔案超過 ${Math.round(deps.config.maxUploadBytes / 1024 / 1024)} MB。`);
    const bytes = new Uint8Array(await part.arrayBuffer());
    const row = saveFile(deps.db, deps.config.dataDir, userId, { bytes, originalName: part.name, declaredMime: part.type || undefined }, deps.now());
    return c.json(fileDto(row), 201);
  });

  app.get('/:id/:name?', c => {
    const deps = c.get('deps');
    const row = loadFile(deps.db, c.get('auth')!.user.id, c.req.param('id'));
    const etag = `"${row.sha256}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' });
    const path = blobPath(deps.config.dataDir, row.sha256);
    let size: number;
    try { size = statSync(path).size; } catch { throw new AppError('not_found', '檔案內容遺失。'); }
    const inline = servesInline(row.mime);
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`;
    const headers: Record<string, string> = {
      'Content-Type': row.mime, 'Content-Length': String(size), ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': disposition, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
    };
    if (!inline) headers['Content-Security-Policy'] = 'sandbox';
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, headers);
  });

  app.delete('/:id', c => {
    const deps = c.get('deps');
    deleteFile(deps.db, deps.config.dataDir, c.get('auth')!.user.id, c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
