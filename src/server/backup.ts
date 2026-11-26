// Online backup: a consistent SQLite snapshot, and beside it the attachments that snapshot refers to.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './db/driver.ts';
import { openDatabase } from './db/driver.ts';
import { blobPath } from './services/storage.ts';

export const KEPT_BACKUPS = 7;
/** How often the snapshot is taken again when an attachment it refers to was deleted while it was being made. */
const ATTEMPTS = 5;
/**
 * `notes-<time>.sqlite` is a snapshot with every attachment it refers to. One that misses attachments is named
 * `notes-<time>.incomplete.sqlite`: it never takes the place of a complete one among those that are kept.
 */
const SNAPSHOT = /^(notes-[^.]+)(\.incomplete)?\.sqlite$/;
const UNFINISHED = /^notes-.+\.(sqlite\.partial(-wal|-shm)?|files\.partial)$/;
const KEPT_FILES = /^notes-.+\.files$/;
/**
 * Where a snapshot's attachments are kept: a folder beside it, laid out like `DATA_DIR/files`. They are hard links
 * to the stored files, so they take no extra space, and a file deleted from the notes afterwards stays readable for
 * as long as a snapshot that refers to it is kept.
 */
export const backupFilesDir = (snapshot: string): string => snapshot.replace(/\.sqlite$/, '.files');

const hashes = (db: Db): string[] => db.all<{ sha256: string }>('SELECT DISTINCT sha256 FROM files').map(row => row.sha256);
const keptPath = (target: string, sha256: string): string => join(target, sha256.slice(0, 2), sha256.slice(2, 4), sha256);

/** Returns the hashes whose stored file is not there (any more). */
function keepFiles(dataDir: string, target: string, list: string[]): string[] {
  const missing: string[] = [];
  for (const sha256 of list) {
    const source = blobPath(dataDir, sha256), kept = keptPath(target, sha256);
    if (existsSync(kept)) continue;
    if (!existsSync(source)) { missing.push(sha256); continue; }
    mkdirSync(dirname(kept), { recursive: true });
    // Where the volume cannot link (some bind mounts), the snapshot gets a copy of its own.
    try { linkSync(source, kept); } catch { try { copyFileSync(source, kept); } catch { missing.push(sha256); } }
  }
  return missing;
}

/** Drops what was kept for a file the snapshot does not refer to after all (deleted just before it was taken). */
function dropOthers(target: string, list: string[]): void {
  const wanted = new Set(list);
  for (const first of readdirSync(target)) for (const second of readdirSync(join(target, first))) for (const name of readdirSync(join(target, first, second))) {
    if (!wanted.has(name)) rmSync(join(target, first, second, name), { force: true });
  }
}

/**
 * One backup at a time, for the whole data directory: a write transaction on a small database of its own, held
 * until the run ends. The system releases it when the process dies, so nothing is ever left locked, and what an
 * earlier run left unfinished can be cleared without wondering whether that run is still going.
 */
function lockBackups(dataDir: string): () => void {
  // Kept out of `backups/`, which is packed up and carried away as it is.
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });
  let lock: Db | undefined;
  try {
    lock = openDatabase(join(dataDir, 'tmp', 'backup.lock'));
    lock.exec('PRAGMA busy_timeout=0');
    lock.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try { lock?.close(); } catch { /* nothing was held */ }
    // Only "busy" means somebody else holds it; a lock file that cannot be opened is reported as what it is.
    const busy = (error as { errcode?: number }).errcode === 5 || /database is locked|SQLITE_BUSY/i.test(error instanceof Error ? error.message : '');
    throw busy ? new Error('另一個備份正在執行，請等它結束後再試。') : error;
  }
  const held = lock;
  return () => { try { held.exec('ROLLBACK'); } finally { held.close(); } };
}

export interface BackupResult {
  backup: string;
  /** Complete snapshots in the folder after this run. */
  kept: number;
  /** Snapshots that miss attachments, kept beside them without counting as one of them. */
  keptIncomplete: number;
  /** Attachments the snapshot refers to. */
  files: number;
  /** Of those, the ones that are not stored any more. */
  missingFiles: number;
  /** How many times the snapshot was taken. */
  attempts: number;
}

/**
 * Takes a snapshot named after `at` and keeps its attachments with it. Both are prepared under a temporary name and
 * only take their final names once finished, so a run that is interrupted never leaves something that looks like a
 * backup. An attachment that is uploaded, caught by the snapshot and deleted again before it could be kept makes the
 * snapshot be taken again.
 *
 * The newest `KEPT_BACKUPS` complete snapshots are kept. A snapshot that misses attachments (lost before this run)
 * is still published, since it has all the text, but under a name of its own: it never pushes a complete snapshot
 * out, which may be the last place that still has those files. Such snapshots are kept up to the same number, and
 * no longer than the complete ones of their time.
 */
export async function runBackup(db: Db, dataDir: string, at: Date = new Date()): Promise<BackupResult> {
  const directory = join(dataDir, 'backups');
  mkdirSync(directory, { recursive: true });
  const unlock = lockBackups(dataDir);
  try {
    // Nothing else is running: whatever is unfinished was left by a run that ended, as are attachments whose snapshot is gone.
    for (const name of readdirSync(directory)) {
      const leftover = UNFINISHED.test(name) || (KEPT_FILES.test(name) && !existsSync(join(directory, name.replace(/\.files$/, '.sqlite'))));
      if (leftover) rmSync(join(directory, name), { recursive: true, force: true });
    }
    const stem = join(directory, `notes-${at.toISOString().replace(/[:.]/g, '-')}`);
    const partial = `${stem}.sqlite.partial`, partialTarget = `${stem}.files.partial`;
    if (existsSync(`${stem}.sqlite`) || existsSync(`${stem}.incomplete.sqlite`)) throw new Error('同一時間的備份已經存在。');
    let list: string[] = [], missing: string[] = [], attempts = 0;
    for (let again = true; again;) {
      attempts++;
      rmSync(partial, { force: true });
      mkdirSync(partialTarget, { recursive: true });
      // Once before the snapshot, so a file that is deleted right after it was taken is already kept.
      keepFiles(dataDir, partialTarget, hashes(db));
      await db.backup(partial);
      const snapshot = openDatabase(partial);
      try { list = hashes(snapshot); } finally { snapshot.close(); }
      missing = keepFiles(dataDir, partialTarget, list);
      // Missing here but no longer referenced by the notes: deleted while the snapshot was made. A new snapshot
      // will not refer to it. Missing and still referenced: lost before this run, which no retry brings back.
      const current = new Set(hashes(db));
      again = attempts < ATTEMPTS && missing.some(sha256 => !current.has(sha256));
    }
    dropOthers(partialTarget, list);
    const file = `${stem}${missing.length ? '.incomplete' : ''}.sqlite`;
    // The attachments first: a snapshot under its final name always has them beside it.
    renameSync(partialTarget, backupFilesDir(file));
    renameSync(partial, file);

    const drop = (name: string) => { rmSync(join(directory, name), { force: true }); rmSync(backupFilesDir(join(directory, name)), { recursive: true, force: true }); };
    const snapshots = readdirSync(directory).filter(name => SNAPSHOT.test(name)).sort();
    let complete = snapshots.filter(name => !SNAPSHOT.exec(name)![2]), incomplete = snapshots.filter(name => SNAPSHOT.exec(name)![2]);
    complete.slice(0, Math.max(0, complete.length - KEPT_BACKUPS)).forEach(drop);
    complete = complete.slice(-KEPT_BACKUPS);
    // Once the complete ones fill their number, an incomplete one from before the oldest of them has had its time.
    const oldest = complete.length === KEPT_BACKUPS ? SNAPSHOT.exec(complete[0]!)![1]! : '';
    const expired = new Set([...incomplete.slice(0, Math.max(0, incomplete.length - KEPT_BACKUPS)), ...incomplete.filter(name => SNAPSHOT.exec(name)![1]! < oldest)]);
    expired.forEach(drop);
    incomplete = incomplete.filter(name => !expired.has(name));
    return { backup: file, kept: complete.length, keptIncomplete: incomplete.length, files: list.length, missingFiles: missing.length, attempts };
  } finally {
    // Whatever this run did not get to publish. The lock is given back whatever happens to that.
    try { for (const name of readdirSync(directory)) if (UNFINISHED.test(name)) rmSync(join(directory, name), { recursive: true, force: true }); }
    finally { unlock(); }
  }
}
