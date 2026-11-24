import type { ErrorBody, ErrorCode } from '@shared/errors';
import { errorMessages } from '@shared/errors';
import { connectionState, recordConnectionResult } from '../offline/connection.ts';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null): void => { csrfToken = token; };
export const getCsrfToken = (): string | null => csrfToken;

export const AUTH_LOST_EVENT = 'notes:auth-lost';

interface RequestOptions { json?: unknown; form?: FormData; signal?: AbortSignal; keepalive?: boolean; headers?: Record<string, string>; cache?: RequestCache }

const NETWORK_ERROR = '無法連線到伺服器，請檢查網路。';
const WEAK_CONNECTION = '連線不穩，請等連線穩定後再試。';

function requestTimeout(method: string, path: string): number | undefined {
  if (method === 'GET') return path.startsWith('/api/offline/') ? 20_000 : 3_000;
  if (path === '/api/files') return 120_000;
  if (path.startsWith('/api/offline/')) return 15_000;
  return undefined;
}

/** Same-origin JSON client: cookies for auth, CSRF header on mutations, typed errors, 401 → global event. */
export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
  const publicRequest = path.startsWith('/api/public/');
  if (!publicRequest && !['/api/auth/me', '/api/auth/status', '/api/auth/login', '/api/auth/register'].includes(path) && connectionState() === 'unstable') {
    throw new ApiError(0, 'internal', WEAK_CONNECTION);
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.json !== undefined) init.body = JSON.stringify(options.json);
  else if (options.form) init.body = options.form;
  if (options.keepalive) init.keepalive = true;
  if (options.cache) init.cache = options.cache;
  const timeout = requestTimeout(method, path);
  const controller = timeout === undefined ? undefined : new AbortController();
  const timer = controller && setTimeout(() => controller.abort(), timeout);
  const cancel = () => controller?.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else if (controller) options.signal?.addEventListener('abort', cancel, { once: true });
  if (controller || options.signal) init.signal = controller?.signal ?? options.signal;
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, init);
    if (response.status === 401 && path !== '/api/auth/login' && !publicRequest) window.dispatchEvent(new Event(AUTH_LOST_EVENT));
    // A slow or interrupted error body must not turn a known denial into a cache hit.
    text = response.status === 204 ? '' : await response.text().catch(error => {
      if (response.status >= 400 && response.status < 500) return '';
      throw error;
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!publicRequest) recordConnectionResult(false);
    const timeout = controller?.signal.aborted === true;
    throw new ApiError(0, 'internal', timeout ? WEAK_CONNECTION : NETWORK_ERROR, { timeout });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
  if (!publicRequest && !options.signal?.aborted) {
    if (response.status < 500) recordConnectionResult(true);
    else if ([502, 503, 504].includes(response.status)) recordConnectionResult(false);
  }
  if (response.status === 204) return undefined as T;
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) {
    const error = (body as ErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'internal', error?.message ?? errorMessages.internal, error?.details);
  }
  return body as T;
}

export const isApiError = (error: unknown, status?: number): error is ApiError => error instanceof ApiError && (status === undefined || error.status === status);
export const errorText = (error: unknown): string => error instanceof Error ? error.message : errorMessages.internal;
