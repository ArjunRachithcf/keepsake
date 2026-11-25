// The migrations in drizzle/, applied in order, build exactly the database src/db/schema.ts describes, and the latest
// Drizzle snapshot is in sync (`pnpm db:generate` has nothing to add). A released migration never changes.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('0003 (M4) keeps an M3 database\'s draws: participants, exclusions and sealed rows survive, claims and audit too', () => {
    // The database as M3 left it: only 0000-0002 applied.
    const dir = mkdtempSync(join(tmpdir(), 'keepsake-mig-'));
    try {
      mkdirSync(join(dir, 'meta'));
      const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
      const m3 = journal.entries.filter((e) => e.idx <= 2);
      writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: m3 }));
      for (const e of m3) copyFileSync(join(drizzleDir, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
      const file = join(dir, 'k.sqlite');
      process.env.KEEPSAKE_MIGRATIONS_DIR = dir;
      const old = openDb(file);
      const c = old.$client;
      const at = '2026-11-01T10:00:00.000Z';
      c.prepare("insert into person (id, name, role, created_at) values ('p1','A','admin',?),('p2','B','adult',?)").run(at, at);
      c.prepare("insert into celebration (id, name, date, poster, recurrence, created_at) values ('c1','X','2026-12-24','pine','yearly',?)").run(at);
      c.prepare("insert into wish (id, person_id, name, position, state, created_at, updated_at) values ('w1','p1','Kite',0,'listed',?,?)").run(at, at);
      c.prepare("insert into claim (id, wish_id, giver_id, quantity, state, created_at, updated_at) values ('cl1','w1','p2',1,'claimed',?,?)").run(at, at);
      c.prepare("insert into draw (id, celebration_id, year, rules_version, created_at, updated_at) values ('d1','c1',2026,1,?,?)").run(at, at);
      c.prepare("insert into draw_participant (id, draw_id, kind, person_id, created_at) values ('dp1','d1','person','p1',?),('dp2','d1','person','p2',?)").run(at, at);
      c.prepare("insert into draw_exclusion (draw_id, a, b) values ('d1','dp1','dp2')").run();
      c.prepare("insert into draw_assignment (draw_id, giver_id, sealed, key_id) values ('d1','dp1',x'00','k'),('d1','dp2',x'01','k')").run();
      c.prepare("insert into audit (id, at, actor_id, action, subject_id) values ('a1',?,'p1','drawn','d1')").run(at);
      c.close();
      delete process.env.KEEPSAKE_MIGRATIONS_DIR;
      const now = openDb(file).$client;
      const n = (table: string) => (now.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
      expect([n('draw_participant'), n('draw_exclusion'), n('draw_assignment'), n('claim'), n('audit')]).toEqual([2, 1, 2, 1, 1]);
      expect(now.prepare('select guest_id from claim').get()).toEqual({ guest_id: null });
      now.close();
    } finally {
      delete process.env.KEEPSAKE_MIGRATIONS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
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
