import type { ErrorBody, ErrorCode } from '@shared/errors';
import { errorMessages } from '@shared/errors';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null): void => { csrfToken = token; };
export const getCsrfToken = (): string | null => csrfToken;

export const AUTH_LOST_EVENT = 'notes:auth-lost';

interface RequestOptions { json?: unknown; form?: FormData; signal?: AbortSignal; keepalive?: boolean; headers?: Record<string, string> }

/** Same-origin JSON client: cookies for auth, CSRF header on mutations, typed errors, 401 → global event. */
export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.json !== undefined) init.body = JSON.stringify(options.json);
  else if (options.form) init.body = options.form;
  if (options.signal) init.signal = options.signal;
  if (options.keepalive) init.keepalive = true;
  let response: Response;
  try { response = await fetch(path, init); } catch (error) { throw new ApiError(0, 'internal', '無法連線到伺服器，請檢查網路。', { cause: String(error) }); }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) {
    const error = (body as ErrorBody | null)?.error;
    if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    throw new ApiError(response.status, error?.code ?? 'internal', error?.message ?? errorMessages.internal, error?.details);
  }
  return body as T;
}

export const isApiError = (error: unknown, status?: number): error is ApiError => error instanceof ApiError && (status === undefined || error.status === status);
export const errorText = (error: unknown): string => error instanceof Error ? error.message : errorMessages.internal;
