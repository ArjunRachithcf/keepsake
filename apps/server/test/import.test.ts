// The one-time sheet import (ADR 0005) with the fictional sample in seed-sample/: the dry run writes nothing and shows
// the plan (names matched or to map, occasions, claims, skipped rows, warnings); applying needs every name mapped or
// skipped and makes everything in one transaction; nothing of the file is kept but what it made; formulas, scripts in
// links and odd prices never come through; size and row limits hold. Admins only (routes.contract.test.ts).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { parseCsv } from '../src/import/import';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

const SAMPLE = readFileSync(new URL('../../../seed-sample/gift-list.csv', import.meta.url), 'utf8');
const apps: BuiltApp[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.app.close(); });

async function start() {
  const db = household();
  db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
  const built = await buildApp(standalone(), db);
  apps.push(built);
  const post = (url: string, payload: object | undefined, who = 'p_alex', method: 'POST' | 'GET' | 'DELETE' = 'POST') =>
    built.app.inject({ method, url, payload, headers: { cookie: sessionCookie(db, who), origin: ORIGIN } });
  return { db, post };
}
const everything = (db: Db) => JSON.stringify(['wish', 'claim', 'group_gift', 'share', 'question', 'idea', 'guest_link', 'celebration', 'person', 'setting']
  .map((n) => db.$client.prepare(`select * from ${n}`).all()));

describe('the sheet import', () => {
  it('the dry run: the plan, and nothing written', async () => {
    const { db, post } = await start();
    const before = everything(db);
    const r = await post('/api/import/dry-run', { csv: SAMPLE });
    expect(r.statusCode, r.body).toBe(200);
    expect(everything(db)).toBe(before);
    const p = r.json();
    expect(p).toMatchObject({ rows: 10, wishes: 6, claims: 3, ready: false });
    expect(p.people).toEqual([
      { name: 'Alex', personId: 'p_alex', status: 'matched', rows: 2 },
      { name: 'Grandpa Joe', personId: null, status: 'unmapped', rows: 1 },
      { name: 'Mia', personId: 'p_mia', status: 'matched', rows: 2 },
      { name: 'Robin', personId: 'p_robin', status: 'matched', rows: 1 },
      { name: 'Sam', personId: 'p_sam', status: 'matched', rows: 2 },
    ]);
    expect(p.occasions).toEqual([
      { name: 'Any time', celebrationId: null, status: 'any', rows: 3 },
      { name: 'Christmas', celebrationId: 'c_xmas', status: 'matched', rows: 1 },
      { name: 'Easter', celebrationId: null, status: 'unmatched', rows: 1 },
      { name: 'Mia\'s birthday', celebrationId: 'c_mia', status: 'matched', rows: 1 },
    ]);
    expect(p.buyers).toEqual([{ name: 'Mia', personId: 'p_mia', rows: 1 }, { name: 'Nobody Here', personId: null, rows: 1 }, { name: 'Sam', personId: 'p_sam', rows: 1 }]);
    expect(p.skipped).toEqual([{ row: 4, reason: 'bought' }, { row: 8, reason: 'person_unmapped' }, { row: 9, reason: 'no_item' }, { row: 10, reason: 'no_person' }]);
    expect(p.warnings).toEqual([{ row: 6, kind: 'link_dropped' }, { row: 6, kind: 'buyer_unknown' }, { row: 7, kind: 'price_dropped' }, { row: 11, kind: 'buyer_unknown' }]);
  });

  it('applying waits for every name; then makes it all, in one go, and keeps nothing else of the file', async () => {
    const { db, post } = await start();
    const before = everything(db);
    const refused = await post('/api/import', { csv: SAMPLE });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'map or skip every name in the file first']);
    expect(everything(db)).toBe(before);
    expect((await post('/api/import', { csv: SAMPLE, people: { 'Grandpa Joe': 'p_nobody' } })).statusCode).toBe(400);
    const done = await post('/api/import', { csv: SAMPLE, people: { 'grandpa joe': null }, occasions: { Easter: 'c_xmas' } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({ wishes: 6, claims: 3, skipped: 4 });
    const made = db.select().from(t.wish).all().filter((w) => !before.includes(w.id));
    const by = (name: string) => made.find((w) => w.name === name)!;
    expect(by('A two-person tent')).toMatchObject({ personId: 'p_alex', celebrationId: 'c_xmas', priceMinor: 24900, mostWanted: 1, link: 'https://shop.example/tent', note: 'Green if possible', state: 'listed', addedBy: 'p_alex' });
    expect(by('Hiking socks, wool')).toMatchObject({ priceMinor: 2450, celebrationId: null });
    expect(by('A red bike')).toMatchObject({ personId: 'p_mia', celebrationId: 'c_mia', link: null, mostWanted: 1, note: 'Size 20", with a bell\nand a basket' });
    // Easter mapped to Christmas, which Mia is part of.
    expect(by('Glitter slime')).toMatchObject({ celebrationId: 'c_xmas', priceMinor: null });
    expect(by('A wool scarf')).toMatchObject({ note: 'SUM(A1:A9)' });
    expect(made.map((w) => w.name)).toContain('HYPERLINK("http://evil.example";"click")');
    // Reserved → a claim by the household member named; a buyer who is nobody here who may give (Nobody Here; Mia
    // for herself) → nobody's imported reservation, so nobody buys it twice (review L1). Never a formula at the start.
    const claims = db.select().from(t.claim).all().filter((c) => made.some((w) => w.id === c.wishId));
    const of = (c: typeof claims[number]) => made.find((w) => w.id === c.wishId)!.name;
    expect(claims.map((c) => [of(c), c.giverId, c.imported, c.state]).sort()).toEqual([
      ['A red bike', null, 1, 'claimed'], ['A wool scarf', null, 1, 'claimed'], ['Hiking socks, wool', 'p_sam', 0, 'claimed']]);
    // Givers see it as an imported reservation; an admin releases it (audited), nobody else, and never its person.
    const scarf = by('A wool scarf').id;
    expect((await post('/api/people/p_robin', undefined, 'p_sam', 'GET')).json().wishes.find((w: { id: string }) => w.id === scarf).gift.claims).toEqual([{ giver: null, guest: null, imported: true, quantity: 1, state: 'claimed', mine: false }]);
    expect((await post(`/api/wishes/${scarf}/imported-claim`, undefined, 'p_sam', 'DELETE')).statusCode).toBe(403);
    expect((await post(`/api/wishes/${scarf}/imported-claim`, undefined, 'p_robin', 'DELETE')).json().error).toBe('your own wishes are for others to give');
    expect((await post(`/api/wishes/${scarf}/imported-claim`, undefined, 'p_alex', 'DELETE')).statusCode).toBe(204);
    expect((await post(`/api/wishes/${scarf}/imported-claim`, undefined, 'p_alex', 'DELETE')).json().error).toBe('no such reservation');
    expect(db.select().from(t.audit).all().filter((a) => a.action === 'reservation_released').map((a) => [a.actorId, a.subjectId])).toEqual([['p_alex', scarf]]);
    for (const w of made) for (const v of [w.name, w.note ?? '']) expect(v).not.toMatch(/^[=+\-@\t\r]/);
    const after = everything(db);
    for (const gone of ['Grandpa Joe', 'pipe stand', 'Nobody Here', 'already wrapped', 'orphan', 'empty row', 'javascript', 'not a price', 'Easter']) expect(after, gone).not.toContain(gone);
    expect(db.select().from(t.audit).all().filter((a) => a.action === 'imported').map((a) => a.actorId)).toEqual(['p_alex']);
  });

  it('limits: size, rows, columns, quotes; grown-ups who are not admins are refused', async () => {
    const { post } = await start();
    const big = 'Person,Item\n' + 'Alex,x\n'.repeat(2001);
    expect((await post('/api/import/dry-run', { csv: big })).json().error).toBe('the file has more than 2000 rows');
    expect((await post('/api/import/dry-run', { csv: 'Name,Thing\nAlex,x' })).json().error).toBe('the file needs the columns Person and Item');
    expect((await post('/api/import/dry-run', { csv: 'Person,Item\n"Alex,x' })).json().error).toBe('the file is not a CSV the importer reads');
    expect((await post('/api/import/dry-run', { csv: 'x'.repeat(512 * 1024 + 1) })).statusCode).toBe(400);
    expect((await post('/api/import/dry-run', { csv: SAMPLE }, 'p_robin')).statusCode).toBe(403);
    expect((await post('/api/import/dry-run', { csv: SAMPLE, people: { x: 5 } })).statusCode).toBe(400);
  });

  it('the parser: quotes, doubled quotes, CRLF, a BOM, blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n,\nlast,row')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['last', 'row']]);
  });
});
