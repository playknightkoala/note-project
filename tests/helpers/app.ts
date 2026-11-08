import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.ts';
import type { AppDeps } from '../../src/server/app.ts';
import { RateLimiter } from '../../src/server/auth/rateLimit.ts';
import { loadConfig } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db/driver.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { silentLogger } from '../../src/server/logger.ts';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  dataDir: string;
  clock: { now: number };
  /** A browser-like client with its own cookie jar and CSRF token. */
  client(): TestClient;
  close(): void;
}

export interface TestClient {
  cookie: string | null;
  csrf: string | null;
  request(method: string, path: string, options?: { json?: unknown; headers?: Record<string, string>; body?: RequestInit['body']; csrf?: boolean; origin?: string | null }): Promise<Response>;
  register(input: Record<string, unknown>): Promise<Response>;
  login(identifier: string, password: string): Promise<Response>;
}

/** In-memory SQLite, temporary data directory, fixed clock: every test gets an isolated server. */
export function createTestApp(): TestApp {
  const dataDir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, COOKIE_SECURE: 'false' });
  const db = openDatabase(':memory:');
  migrate(db);
  const clock = { now: 1_800_000_000_000 };
  const deps: AppDeps = { db, config, logger: silentLogger, now: () => clock.now, rateLimiter: new RateLimiter() };
  const app = createApp(deps);
  const client = (): TestClient => {
    const state: TestClient = {
      cookie: null, csrf: null,
      async request(method, path, options = {}) {
        const headers: Record<string, string> = { ...(options.headers ?? {}) };
        if (options.json !== undefined) headers['content-type'] = 'application/json';
        if (state.cookie) headers.cookie = state.cookie;
        if (options.csrf !== false && state.csrf && !['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = state.csrf;
        if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost';
        const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
        const response = await app.request(`http://localhost${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
          const pair = setCookie.split(';')[0]!;
          state.cookie = /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookie) ? null : pair;
        }
        return response;
      },
      async register(input) {
        const response = await state.request('POST', '/api/auth/register', { json: input });
        if (response.ok) state.csrf = ((await response.clone().json()) as { csrfToken: string }).csrfToken;
        return response;
      },
      async login(identifier, password) {
        const response = await state.request('POST', '/api/auth/login', { json: { identifier, password } });
        if (response.ok) state.csrf = ((await response.clone().json()) as { csrfToken: string }).csrfToken;
        return response;
      },
    };
    return state;
  };
  return { app, deps, dataDir, clock, client, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
