// The migrations in drizzle/, applied in order, build exactly the database src/db/schema.ts describes, and the latest
// Drizzle snapshot is in sync (`pnpm db:generate` has nothing to add). A released migration never changes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { openDb } from '../src/db/open';
import * as schema from '../src/db/schema';

function checks(sql: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  while (re.exec(sql)) {
    let depth = 1, i = re.lastIndex, quote = false;
    for (; i < sql.length && depth > 0; i++) {
      const c = sql[i];
      if (c === "'") quote = !quote;
      else if (!quote && c === '(') depth++;
      else if (!quote && c === ')') depth--;
    }
    out.push(sql.slice(re.lastIndex, i - 1).replace(/"?\w+"?\."?(\w+)"?/g, '$1').replace(/["`]/g, '').replace(/\s+/g, '').toLowerCase());
  }
  return out.sort();
}

/** Tables, columns, keys, indexes and CHECKs of a database, normalised. */
function describeDb(db: Database.Database) {
  const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`).all() as { name: string; sql: string }[];
  return Object.fromEntries(tables.map(({ name, sql }) => {
    const q = JSON.stringify(name);
    const cols = (db.prepare(`PRAGMA table_info(${q})`).all() as { type: string }[]).map((c) => ({ ...c, type: c.type.toUpperCase() }));
    const fks = (db.prepare(`PRAGMA foreign_key_list(${q})`).all() as { table: string; from: string; to: string; on_delete: string }[])
      .map((f) => `${f.from}->${f.table}.${f.to} del:${f.on_delete.toUpperCase()}`).sort();
    const idx = (db.prepare(`PRAGMA index_list(${q})`).all() as { name: string; unique: number; origin: string }[]).filter((i) => i.origin !== 'pk')
      .map((i) => `${i.unique ? 'unique' : i.name}(${(db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as { name: string }[]).map((c) => c.name).join(',')})`).sort();
    return [name, { cols, fks, idx, checks: checks(sql) }];
  }));
}

const drizzleDir = fileURLToPath(new URL('../drizzle', import.meta.url));
const fromSql = (statements: string[]) => { const db = new Database(':memory:'); for (const s of statements) db.exec(s); return db; };

describe('migrations', () => {
  it('build the database the Drizzle schema describes, with foreign keys on', async () => {
    const migrated = openDb(':memory:');
    const fromTs = fromSql(await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema)));
    expect(describeDb(migrated.$client)).toEqual(describeDb(fromTs));
    expect(migrated.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('the latest snapshot is in sync with the schema', async () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number }[] };
    const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', `${String(journal.entries.at(-1)!.idx).padStart(4, '0')}_snapshot.json`), 'utf8'));
    expect(await generateSQLiteMigration(snapshot, await generateSQLiteDrizzleJson(schema, snapshot.id))).toEqual([]);
  });
});

// Filled in at each release (none yet: 0000_init.sql may still change until 0.1.0 ships).
const RELEASED: Record<string, string> = {};
describe.skipIf(Object.keys(RELEASED).length === 0)('released migrations', () => {
  it.each(Object.entries(RELEASED))('%s is unchanged', (file, sha) => {
    expect(createHash('sha256').update(readFileSync(join(drizzleDir, file))).digest('hex')).toBe(sha);
  });
});
