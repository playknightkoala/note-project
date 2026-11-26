// Operator commands: run inside the container, e.g. `docker compose exec app node dist/server/cli.js backup`.
import { join } from 'node:path';
import { runBackup } from './backup.ts';
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
    const result = await runBackup(db, config.dataDir);
    console.log(JSON.stringify(result));
    if (result.missingFiles > 0) {
      console.error(`警告：筆記引用的附件有 ${result.missingFiles} 個在 files/ 裡找不到，還原這份備份後這些附件無法開啟。它已另存為 .incomplete.sqlite，不佔用完整備份的保留名額；較舊的完整備份可能還保有這些檔案，請處理後再備份一次。`);
      process.exitCode = 1;
    }
  } else if (command === 'rebuild-index') {
    db.exec("INSERT INTO page_fts(page_fts) VALUES('rebuild')");
    console.log(JSON.stringify({ rebuilt: true }));
  } else {
    console.log('用法：cli <migrate|backup|rebuild-index>');
    process.exitCode = command === 'help' ? 0 : 1;
  }
}

main().finally(() => db.close());
