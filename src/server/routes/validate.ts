import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';

/** Parses a JSON body against a zod schema; the first issue becomes the user-facing message. */
export async function parseBody<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  // HTML forms cannot send application/json cross-site, so this also keeps form posts away from JSON endpoints.
  if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) throw new AppError('unsupported_media', '請以 application/json 傳送。');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError('bad_request', '請求內容不是有效的 JSON。'); }
  return parseValue(raw, schema);
}

export function parseValue<T extends z.ZodTypeAny>(raw: unknown, schema: T): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? '';
    throw new AppError('bad_request', issue ? `${path ? path + '：' : ''}${issue.message}` : undefined, { issues: result.error.issues.map(i => ({ path: i.path, message: i.message })) });
  }
  return result.data;
}

/** Rejects by Content-Length when declared, otherwise counts the stream and stops reading at the limit. */
export function requestBodyLimit(maxSize: number, message?: string): MiddlewareHandler<AppEnv> {
  return bodyLimit({ maxSize, onError: () => { throw new AppError('payload_too_large', message); } });
}
