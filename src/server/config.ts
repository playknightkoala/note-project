import { z } from 'zod';

const blank = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATA_DIR: z.string().default('data'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  PUBLIC_ORIGIN: z.preprocess(blank, z.string().url().optional()),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(90),
  MAX_IMPORT_MB: z.coerce.number().int().min(1).max(4096).default(200),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CLIENT_IP_HEADER: z.preprocess(blank, z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional()),
  SETUP_TOKEN: z.preprocess(blank, z.string().min(16).max(200).optional()),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  trustProxy: boolean;
  cookieSecure: 'auto' | boolean;
  publicOrigin: string | undefined;
  maxUploadBytes: number;
  maxImportBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Header a trusted proxy sets to the real client address (e.g. cf-connecting-ip); only read when trustProxy is on. */
  clientIpHeader: string | undefined;
  /** When set, creating the first (admin) account requires this value in place of an invite code. */
  setupToken: string | undefined;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`環境變數設定錯誤：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  const value = parsed.data;
  return {
    env: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    dataDir: value.DATA_DIR,
    trustProxy: value.TRUST_PROXY === '1',
    cookieSecure: value.COOKIE_SECURE === 'auto' ? 'auto' : value.COOKIE_SECURE === 'true',
    publicOrigin: value.PUBLIC_ORIGIN?.replace(/\/+$/, ''),
    maxUploadBytes: value.MAX_UPLOAD_MB * 1024 * 1024,
    maxImportBytes: value.MAX_IMPORT_MB * 1024 * 1024,
    logLevel: value.LOG_LEVEL,
    clientIpHeader: value.CLIENT_IP_HEADER?.toLowerCase(),
    setupToken: value.SETUP_TOKEN,
    version: process.env.NOTES_VERSION ?? '0.0.0',
  };
}
