// Opens (and migrates) the SQLite database in the data folder.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** drizzle/ next to the bundle (dist/) or two levels up from this file (src/db/). */
export function migrationsDir(): string {
  if (process.env.KEEPSAKE_MIGRATIONS_DIR) return process.env.KEEPSAKE_MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, '../drizzle'), join(here, '../../drizzle')]) if (existsSync(join(d, 'meta/_journal.json'))) return d;
  throw new Error('drizzle migrations folder not found; set KEEPSAKE_MIGRATIONS_DIR');
}

/** `file` is a path or ':memory:'. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The data folder too, when it is ours (made by `mkdir data` with the usual umask, it would be 0755).
    try { chmodSync(dirname(file), 0o700); } catch { /* not ours to change: the files themselves are 0600 below */ }
  }
  const client = new Database(file);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  // What is deleted is overwritten with zeros, not left in free pages (Gate surprise L4: a question taken back, its
  // asker). The WAL keeps older copies of a page until a checkpoint: `checkpoint` below, at every tick of the queue.
  client.pragma('secure_delete = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  // The household's data is for Keepsake's user only, whatever the umask was (main.ts sets 077 too).
  if (file !== ':memory:') for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return db as Db;
}

/**
 * Moves the WAL into the database and empties it, so a deleted row's older copies leave the WAL too (Gate surprise L4).
 * Cheap for a household's database; skipped (nothing happens) while another connection holds a read open.
 */
export function checkpoint(db: Db): void {
  db.$client.pragma('wal_checkpoint(TRUNCATE)');
}

/** A transaction handle used where a Db is expected (same API for what we use). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export const asDb = (tx: Tx) => tx as unknown as Db;
