import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { AppError } from '../../shared/errors.ts';

/** Parses a JSON body against a zod schema; the first issue becomes the user-facing message. */
export async function parseBody<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
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
