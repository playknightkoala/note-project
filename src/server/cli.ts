// Operator commands: run inside the container, e.g. `docker compose exec app node dist/server/cli.js backup`.
import { join } from 'node:path';
import { readdirSync, unlinkSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/driver.ts';
import { migrate } from './db/migrate.ts';

const config = loadConfig();
const [command = 'help'] = process.argv.slice(2);
const db = openDatabase(join(config.dataDir, 'notes.sqlite'));

async function main(): Promise<void> {
  if (command === 'migrate') {
    console.log(JSON.stringify({ applied: migrate(db) }));
  } else if (command === 'backup') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(config.dataDir, 'backups', `notes-${stamp}.sqlite`);
    await db.backup(file);
    const backups = readdirSync(join(config.dataDir, 'backups')).filter(name => name.endsWith('.sqlite')).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - 7))) unlinkSync(join(config.dataDir, 'backups', old));
    console.log(JSON.stringify({ backup: file, kept: Math.min(backups.length, 7) }));
  } else if (command === 'rebuild-index') {
    db.exec("INSERT INTO page_fts(page_fts) VALUES('rebuild')");
    console.log(JSON.stringify({ rebuilt: true }));
  } else {
    console.log('用法：cli <migrate|backup|rebuild-index>');
    process.exitCode = command === 'help' ? 0 : 1;
  }
}

main().finally(() => db.close());
