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

// Every migration on main is frozen: its SQL and its journal's `when` never change (PR #12 review). A branch's own
// migration may be regenerated until its PR is ready to merge; that PR adds it here.
const ON_MAIN: Record<string, { sha256: string; when: number }> = {
  '0000_init': { sha256: '2309b6c89f3beb972cd25d400fb587cd0f97880434c723e1ab51c9f28d4c3bc0', when: 1795563590530 },
  '0001_gifts': { sha256: 'c659f8594bfefb7cffab20c6d148d2b13d256cdae4102d88f17d64ded2173b60', when: 1795570312184 },
  '0002_draws': { sha256: '722a104f5aa0fe16a848f9661c3702b081a0e11342b6ca1df5fe76aaa2a2b2d3', when: 1795587420196 },
  '0003_m4': { sha256: '078e51e56cedbac7d54b788fd71cd9477e331a74893662d462fe2116cb7fd203', when: 1795589205530 },
  // Frozen with PR #12, the merge that brings it to main (PR #12 third review, L5).
  '0004_m5': { sha256: '3cdc27ac0361a9f1bfa8d52573295a139f582ad0eedd9b35e7c607e2fb3ab3b5', when: 1795653454859 },
};
describe('the migrations already on main', () => {
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
  it.each(Object.entries(ON_MAIN))('%s is unchanged (its SQL and its place in the journal)', (tag, frozen) => {
    expect(createHash('sha256').update(readFileSync(join(drizzleDir, `${tag}.sql`))).digest('hex')).toBe(frozen.sha256);
    const e = journal.entries.find((x) => x.tag === tag);
    expect(e && { when: e.when, idx: e.idx }).toEqual({ when: frozen.when, idx: Number(tag.slice(0, 4)) });
  });
  it('come first, in order, and every later one is newer', () => {
    const tags = Object.keys(ON_MAIN);
    expect(journal.entries.slice(0, tags.length).map((e) => e.tag)).toEqual(tags);
    const last = Math.max(...Object.values(ON_MAIN).map((x) => x.when));
    for (const e of journal.entries.slice(tags.length)) expect(e.when).toBeGreaterThan(last);
  });
});
