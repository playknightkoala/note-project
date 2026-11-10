import { serve } from '@hono/node-server';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { assertSqliteCapabilities, openDatabase } from './db/driver.ts';
import { migrate } from './db/migrate.ts';
import { createLogger } from './logger.ts';
import { sweepSessions } from './auth/session.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel);

for (const directory of ['', 'files', 'tmp', 'backups']) mkdirSync(join(config.dataDir, directory), { recursive: true });
try { accessSync(config.dataDir, constants.W_OK); } catch { logger.error('資料目錄無法寫入', { dataDir: config.dataDir }); process.exit(1); }

const db = openDatabase(join(config.dataDir, 'notes.sqlite'));
const { version: sqliteVersion } = assertSqliteCapabilities(db);
const applied = migrate(db);
logger.info('database ready', { sqliteVersion, migrationsApplied: applied });

const clientDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../client');
const app = createApp({ db, config, logger, clientDir });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  logger.info('listening', { host: info.address, port: info.port, version: config.version, env: config.env });
});

// Expired sessions are otherwise only removed when their own cookie is presented again.
const sweep = () => {
  try { const removed = sweepSessions(db, Date.now()); if (removed) logger.info('expired sessions removed', { removed }); }
  catch (error) { logger.warn('session sweep failed', { message: error instanceof Error ? error.message : String(error) }); }
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
