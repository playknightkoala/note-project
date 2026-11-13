import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';
import { refreshAuth } from '../auth/middleware.ts';

/** Parses a JSON body against a zod schema; the first issue becomes the user-facing message. */
export async function parseBody<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  // HTML forms cannot send application/json cross-site, so this also keeps form posts away from JSON endpoints.
  if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) throw new AppError('unsupported_media', '請以 application/json 傳送。');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw bodyOverflow(c) ?? new AppError('bad_request', '請求內容不是有效的 JSON。'); }
  // A body can take minutes to arrive. Whoever sent it must still be signed in once it is here; what they may do
  // with it is for the caller to decide from this point on, not from what was true when the headers came in.
  refreshAuth(c);
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

/** The "too large" error of a body that was cut off while it was being read, if that is why reading it failed. */
export const bodyOverflow = (c: Context<AppEnv>): AppError | undefined => c.get('bodyOverflow');

/**
 * Rejects by Content-Length when declared. A body without one (chunked) is counted while the handler reads it and
 * cut off at the limit. Nothing is read here: a request that is turned away before its body is wanted (not signed
 * in, over a rate limit) costs no memory, however much the client is prepared to send.
 */
export function requestBodyLimit(maxSize: number, message?: string): MiddlewareHandler<AppEnv> {
  const tooLarge = () => new AppError('payload_too_large', message);
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) return next();
    const declared = raw.headers.get('content-length');
    if (declared !== null && !raw.headers.has('transfer-encoding')) {
      if (Number.parseInt(declared, 10) > maxSize) throw tooLarge();
      return next();
    }
    let size = 0;
    const reader = raw.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        size += value.byteLength;
        if (size <= maxSize) { controller.enqueue(value); return; }
        // The rest is simply never read. (The source is left alone rather than cancelled: the answer ends the request.)
        const error = tooLarge();
        c.set('bodyOverflow', error);
        controller.error(error);
      },
    }, { highWaterMark: 0 });
    c.req.raw = new Request(raw, { body, duplex: 'half' } as RequestInit);
    return next();
  };
}
