// Draws (spec §3, ADR 0004), through the API:
// - the rules: the host sets up, draws, re-draws and removes; kids only with "Kids draw too"; exclusions the host's
//   only; an impossible set of rules refused naming the rule; draw together; the reveal; re-draw rules (freely until
//   someone opened theirs; then only before the day, never once a gift is bought, everyone told); the key;
// - the surprise, on the raw responses: for every viewer (the host and admin, adults in and out of the draw, a kid in
//   it, a kid out of it) and every state before the reveal, each reading answer is byte for byte the same whoever the
//   others drew, as long as the viewer's own person is the same: nothing anyone but the giver receives depends on
//   their receiver;
// - the database alone (a copy, a backup) says nothing about who drew whom: the raw tables of two households with
//   different pairs differ only in the sealed bytes, every sealed row has one length, and nothing opens without the key.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { RUNS_A_DAY, sealAssignments } from '../src/draws/draws';
import { openReceiver, sealingKey } from '../src/draws/sealed';
import { isInside, loadConfig } from '../src/config';
import { ORIGIN, TEST_KEY, homerslab, household, inDays, sessionCookie, standalone, withDraws } from './helpers';

const NOW = '2026-11-01T10:00:00.000Z';
const KEY = Buffer.from(TEST_KEY, 'base64');
const PEOPLE = ['alex', 'sam', 'robin', 'mia', 'leo', 'quinn', 'uma'] as const;
type Who = (typeof PEOPLE)[number];

let built: BuiltApp | undefined;
afterEach(async () => { await built?.app.close(); built = undefined; });

/**
 * household() with draws, plus Quinn and Uma (adults). Christmas: Quinn joins it. The draw (Alex hosts): Alex, Sam,
 * Robin, Quinn and, with kids drawing, Mia. Not in it: Leo (a kid), Uma (not in the celebration).
 */
function home(): Db {
  const db = withDraws(household());
  db.insert(t.person).values([
    { id: 'p_quinn', name: 'Quinn', role: 'adult', createdAt: NOW },
    { id: 'p_uma', name: 'Uma', role: 'adult', createdAt: NOW },
  ]).run();
  db.insert(t.celebrationPerson).values({ celebrationId: 'c_xmas', personId: 'p_quinn' }).run();
  db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
  return db;
}
async function start(db: Db, cfg = standalone()) {
  await built?.app.close();
  built = await buildApp(cfg, db);
  const cookies = Object.fromEntries(PEOPLE.map((p) => [p, sessionCookie(db, `p_${p}`)])) as Record<Who, string>;
  const as = (who: Who) => ({
    get: (url: string) => built!.app.inject({ url, headers: { cookie: cookies[who] } }),
    send: (method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object) =>
      built!.app.inject({ method, url, payload, headers: { cookie: cookies[who], origin: ORIGIN } }),
  });
  return as;
}
const DRAW = '/api/celebrations/c_xmas/draw';
const IN = ['p_alex', 'p_sam', 'p_robin', 'p_quinn', 'p_mia'];
const pid = (person: string) => `dp_${person.slice(2)}`;
const audit = (db: Db) => db.select().from(t.audit).all();

/** The draw's participants: Quinn joins Alex, Sam, Robin and (kids drawing) Mia. */
function fiveInDraw(db: Db) {
  db.insert(t.drawParticipant).values({ id: 'dp_quinn', drawId: 'd_xmas', kind: 'person', personId: 'p_quinn', createdAt: NOW }).run();
}

describe('setting up a draw', () => {
  it('only the host (or an admin when there is none) sets it up; never a kid', async () => {
    const db = home();
    const as = await start(db);
    const body = { people: ['p_alex', 'p_sam', 'p_robin'] };
    expect((await as('sam').send('POST', '/api/celebrations/c_cousins/draw', body)).statusCode).toBe(403);
    expect((await as('mia').send('POST', '/api/celebrations/c_cousins/draw', body)).statusCode).toBe(403);
    const ok = await as('alex').send('POST', '/api/celebrations/c_cousins/draw', body);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ drawn: false, opened: 0, total: 3, canManage: true, revealOn: null, exclusions: [], mine: { opened: false, canOpen: false, receiver: null, unreadable: false } });
    expect((await as('alex').send('POST', '/api/celebrations/c_cousins/draw', body)).json()).toEqual({ error: 'this celebration has a draw already' });
    // a celebration whose host left: the admins run it
    db.update(t.celebration).set({ hostId: null }).where(eq(t.celebration.id, 'c_cousins')).run();
    expect((await as('alex').send('PATCH', '/api/celebrations/c_cousins/draw', { budgetMinor: 3000 })).statusCode).toBe(200);
    expect((await as('sam').send('PATCH', '/api/celebrations/c_cousins/draw', { budgetMinor: 3000 })).statusCode).toBe(403);
    expect(audit(db).map((a) => a.action)).toEqual(['draw_created', 'draw_changed']);
  });

  it('checks who draws, the exclusions and the reveal date', async () => {
    const db = home();
    const as = await start(db);
    const post = (b: object) => as('alex').send('POST', '/api/celebrations/c_cousins/draw', b);
    expect((await post({ people: ['p_alex', 'p_uma'] })).json()).toEqual({ error: 'people: someone is not in the celebration' });
    db.insert(t.celebrationPerson).values({ celebrationId: 'c_cousins', personId: 'p_mia' }).run();
    expect((await post({ people: ['p_alex', 'p_mia'] })).json()).toEqual({ error: 'people: a kid draws only when kids draw too' });
    expect((await post({ people: ['p_alex', 'p_sam'], exclusions: [['p_alex', 'p_robin']] })).json()).toEqual({ error: 'exclusions: two different people of the draw each' });
    expect((await post({ people: ['p_alex', 'p_sam'], exclusions: [['p_alex', 'p_alex']] })).json()).toEqual({ error: 'exclusions: two different people of the draw each' });
    expect((await post({ people: ['p_alex'], revealOn: inDays(10) })).json()).toEqual({ error: 'revealOn: a day after the celebration, or never' });
    expect((await post({ people: ['p_alex'], drawTogetherAt: 'tomorrow' })).json()).toEqual({ error: 'drawTogetherAt: a date and time (ISO 8601 with a time zone), or null' });
    expect((await post({ people: ['p_alex'], extra: 1 })).statusCode).toBe(400);
    const ok = await post({ people: ['p_alex', 'p_mia', 'p_sam'], kidsDraw: true, revealOn: inDays(11), drawTogetherAt: '2030-01-01T18:00:00+01:00' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ kidsDraw: true, revealOn: inDays(11), drawTogetherAt: '2030-01-01T17:00:00.000Z' });
    // turning "kids draw too" off with a kid in it
    expect((await as('alex').send('PATCH', '/api/celebrations/c_cousins/draw', { kidsDraw: false })).json()).toEqual({ error: 'people: a kid draws only when kids draw too' });
  });

  it('a budget needs the household\'s currency', async () => {
    const db = home();
    db.delete(t.setting).run();
    const as = await start(db);
    expect((await as('alex').send('PATCH', DRAW, { budgetMinor: 2500 })).json()).toEqual({ error: 'the household has no currency yet: an admin sets it first' });
  });

  it('exclusions are the host\'s only to see', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    const r = await as('alex').send('PATCH', DRAW, { exclusions: [['p_sam', 'p_robin']] });
    expect(r.json().exclusions).toEqual([[{ id: 'p_robin', name: 'Robin' }, { id: 'p_sam', name: 'Sam' }]]);
    for (const who of ['sam', 'robin', 'quinn', 'mia', 'leo', 'uma'] as const) {
      const g = await as(who).get(DRAW);
      expect(g.statusCode).toBe(200);
      expect(g.json().exclusions, who).toBeNull();
    }
  });
});

describe('drawing the names', () => {
  it('refuses rules that cannot be drawn, or that let someone work out another\'s person, naming the rule; audited without pairs', async () => {
    const db = home();
    const as = await start(db);
    const run = async (patch: object) => { await as('alex').send('PATCH', DRAW, patch); return (await as('alex').send('POST', `${DRAW}/run`)).json(); };
    expect(await run({ exclusions: [['p_alex', 'p_sam'], ['p_alex', 'p_robin'], ['p_alex', 'p_mia']] }))
      .toEqual({ error: 'who shouldn\'t draw whom leaves someone nobody to draw: loosen it' });
    // two couples among four: whoever draws, their partner's person is certain (review H3)
    expect(await run({ exclusions: [['p_alex', 'p_sam'], ['p_robin', 'p_mia']] }))
      .toEqual({ error: 'these rules let someone work out another\'s person: add people or loosen who shouldn\'t draw whom' });
    // three: whoever opens theirs knows the whole draw
    expect(await run({ people: ['p_alex', 'p_sam', 'p_robin'], exclusions: [] })).toEqual({ error: 'a draw needs at least 4 people' });
    expect(db.select().from(t.drawAssignment).all()).toEqual([]);
    const rows = audit(db);
    expect(rows.filter((a) => a.action === 'draw_refused')).toHaveLength(3);
    // the audit names who did what to which draw: nothing else
    for (const a of rows) expect(Object.keys(a).sort()).toEqual(['action', 'actorId', 'at', 'id', 'subjectId']);
    expect(new Set(rows.map((a) => a.subjectId))).toEqual(new Set(['d_xmas']));
  });

  it('draws, each giver opens their own, and only they learn their person', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    expect((await as('sam').send('POST', `${DRAW}/run`)).statusCode).toBe(403);
    expect((await as('sam').send('POST', `${DRAW}/open`)).json()).toEqual({ error: 'the names are not drawn yet' });
    const r = await as('alex').send('POST', `${DRAW}/run`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ drawn: true, opened: 0, total: 5, mine: { opened: false, canOpen: true, receiver: null, unreadable: false }, pairs: null });
    expect((await as('leo').send('POST', `${DRAW}/open`)).json()).toEqual({ error: 'you are not in this draw' });
    const received = new Set<string>();
    for (const who of ['sam', 'robin', 'quinn', 'mia', 'alex'] as const) {
      const o = await as(who).send('POST', `${DRAW}/open`);
      expect(o.statusCode, o.body).toBe(200);
      const mine = o.json().mine;
      expect(mine.opened).toBe(true);
      expect(mine.receiver.id).not.toBe(`p_${who}`);
      received.add(mine.receiver.id);
      // opening again changes nothing; GET says the same
      expect((await as(who).get(DRAW)).json().mine).toEqual(mine);
    }
    expect(received).toEqual(new Set(IN));
    expect((await as('uma').get(DRAW)).json()).toMatchObject({ opened: 5, total: 5, mine: null, pairs: null });
    expect((await as('alex').get('/api/celebrations')).json().upcoming.find((c: { id: string }) => c.id === 'c_xmas').draw).toMatchObject({ drawn: true, opened: 5, total: 5, mine: 'opened' });
    expect(audit(db).map((a) => a.action)).toEqual(['drawn']);
  });

  it('nobody opens theirs before the draw-together time', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('PATCH', DRAW, { drawTogetherAt: new Date(Date.now() + 3_600_000).toISOString() });
    await as('alex').send('POST', `${DRAW}/run`);
    expect((await as('sam').get(DRAW)).json().mine).toEqual({ opened: false, canOpen: false, receiver: null, receiverGuest: false, unreadable: false });
    expect((await as('sam').get('/api/home')).json().celebrations.find((c: { id: string }) => c.id === 'c_xmas').draw.mine).toBe('waiting');
    expect((await as('sam').send('POST', `${DRAW}/open`)).json()).toEqual({ error: 'not yet: everyone opens together at the set time' });
    await as('alex').send('PATCH', DRAW, { drawTogetherAt: new Date(Date.now() - 1000).toISOString() });
    expect((await as('sam').get(DRAW)).json().mine.canOpen).toBe(true);
    expect((await as('sam').send('POST', `${DRAW}/open`)).statusCode).toBe(200);
  });

  it('without the sealing key, no draw is made or opened', async () => {
    const db = home();
    await start(db, homerslab('127.0.0.1', { KEEPSAKE_SEALING_KEY: '' }));
    const h = { 'x-homerslab-person': 'hl-alex', 'x-homerslab-name': 'Alex', 'x-homerslab-role': 'admin', origin: ORIGIN };
    const r = await built!.app.inject({ method: 'POST', url: `${DRAW}/run`, headers: h, remoteAddress: '127.0.0.1' });
    expect(r.json()).toEqual({ error: 'draws need the sealing key on the server (KEEPSAKE_SEALING_KEY)' });
    expect(db.select().from(t.draw).get()!.drawnAt).toBeNull();
  });

  it('a key that is not 32 bytes of base64 is no key: draws are refused, and its value is in no answer or error', async () => {
    const db = home();
    const secret = 'not-a-key-but-secret-text';
    const as = await start(db, standalone({ KEEPSAKE_SEALING_KEY: secret }));
    const r = await as('alex').send('POST', `${DRAW}/run`);
    expect(r.json()).toEqual({ error: 'draws need the sealing key on the server (KEEPSAKE_SEALING_KEY)' });
    expect(JSON.stringify(standalone({ KEEPSAKE_SEALING_KEY: secret }))).not.toContain(secret);
  });

  it('is limited to a number of tries a day per celebration and year, which removing and making the draw again does not reset', async () => {
    const db = home();
    const as = await start(db);
    for (let i = 0; i < RUNS_A_DAY - 2; i++) expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    expect((await as('alex').send('DELETE', DRAW)).statusCode).toBe(204);
    expect((await as('alex').send('POST', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_quinn'] })).statusCode).toBe(201);
    for (let i = 0; i < 2; i++) expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    expect((await as('alex').send('POST', `${DRAW}/run`)).json()).toEqual({ error: 'the names were drawn often today: try again tomorrow' });
  });
});

describe('re-drawing', () => {
  it('freely until someone opened theirs; then everyone opens theirs again', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    const again = await as('alex').send('POST', `${DRAW}/run`);
    expect(again.json()).toMatchObject({ drawn: true, redrawnAt: null, canRedraw: true });
    await as('sam').send('POST', `${DRAW}/open`);
    const third = await as('alex').send('POST', `${DRAW}/run`);
    expect(third.statusCode).toBe(200);
    expect(third.json().redrawnAt).not.toBeNull();
    expect((await as('sam').get(DRAW)).json()).toMatchObject({ opened: 0, mine: { opened: false, canOpen: true, receiver: null, unreadable: false } });
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'redrawn', 'redrawn']);
  });

  it('a change of who draws, once drawn, draws again; a refused one leaves the rules as they were', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    await as('sam').send('POST', `${DRAW}/open`);
    const r = await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_quinn'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ total: 4, opened: 0 });
    expect(db.select().from(t.drawAssignment).all()).toHaveLength(4);
    const bad = await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam'] });
    expect(bad.json()).toEqual({ error: 'a draw needs at least 4 people' });
    expect((await as('alex').get(DRAW)).json().total).toBe(4);
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'draw_changed', 'redrawn', 'draw_refused']);
  });

  it('not once a participant has marked a gift bought for another, once someone opened theirs', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    await as('sam').send('POST', `${DRAW}/open`);
    // Quinn bought Sam's cookbook (a Christmas wish)
    await as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 });
    expect((await as('alex').get(DRAW)).json().canRedraw).toBe(true);
    await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'bought' });
    expect((await as('alex').get(DRAW)).json().canRedraw).toBe(false);
    expect((await as('alex').send('POST', `${DRAW}/run`)).json()).toEqual({ error: 'a gift is bought already: the draw stays as it is' });
    expect((await as('alex').send('DELETE', DRAW)).json()).toEqual({ error: 'a gift is bought already: the draw stays as it is' });
  });

  it('a gift bought for the host is not the host\'s to learn: their own wishes are left out', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    await as('sam').send('POST', `${DRAW}/open`);
    await as('quinn').send('PUT', '/api/wishes/w_alex_tent/claim', { quantity: 1 });
    await as('quinn').send('PATCH', '/api/wishes/w_alex_tent/claim', { state: 'bought' });
    expect((await as('alex').get(DRAW)).json().canRedraw).toBe(true);
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
  });

  it('once its day has come, only the reveal date changes', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    const last = db.select().from(t.draw).get()!;
    db.update(t.draw).set({ year: last.year - 1, occasionOn: `${last.year - 1}-12-24` }).where(eq(t.draw.id, 'd_xmas')).run();
    expect((await as('alex').send('POST', `${DRAW}/run`)).json()).toEqual({ error: 'its day has come: the draw stays as it is' });
    expect((await as('alex').send('PATCH', DRAW, { budgetMinor: 100 })).json()).toEqual({ error: 'its day has come: the draw stays as it is' });
    expect((await as('alex').send('DELETE', DRAW)).json()).toEqual({ error: 'its day has come: the draw stays as it is' });
    const r = await as('alex').send('PATCH', DRAW, { revealOn: inDays(0) });
    expect(r.statusCode, r.body).toBe(200);
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'draw_changed', 'reveal_set']);
  });

  it('someone in a drawn draw stays in the celebration until the draw changes; before it is drawn they just leave it', async () => {
    const db = home();
    const as = await start(db);
    const people = ['p_alex', 'p_sam', 'p_mia', 'p_leo', 'p_quinn'];
    const out = await as('alex').send('PATCH', '/api/celebrations/c_xmas', { people });
    expect(out.statusCode).toBe(200);
    expect((await as('alex').get(DRAW)).json().people.map((p: { id: string }) => p.id)).toEqual(['p_alex', 'p_mia', 'p_sam']);
    await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_quinn', 'p_mia'] });
    await as('alex').send('POST', `${DRAW}/run`);
    expect((await as('alex').send('PATCH', '/api/celebrations/c_xmas', { people: ['p_alex', 'p_sam', 'p_mia'] })).json())
      .toEqual({ error: 'they are in the draw: take them out of the draw first' });
  });
});

describe('not last year\'s person', () => {
  async function lastYear(pairs: [string, string][]) {
    const db = home();
    const year = db.select().from(t.draw).get()!.year;
    db.insert(t.draw).values({ id: 'd_last', celebrationId: 'c_xmas', year: year - 1, rulesVersion: 1, drawnAt: NOW, createdAt: NOW, updatedAt: NOW }).run();
    for (const p of ['alex', 'sam', 'robin', 'quinn']) db.insert(t.drawParticipant).values({ id: `dl_${p}`, drawId: 'd_last', kind: 'person', personId: `p_${p}`, createdAt: NOW }).run();
    sealAssignments(db, KEY, 'd_last', new Map(pairs.map(([g, r]) => [`dl_${g}`, `dl_${r}`])));
    db.insert(t.drawParticipant).values({ id: 'dp_quinn', drawId: 'd_xmas', kind: 'person', personId: 'p_quinn', createdAt: NOW }).run();
    db.update(t.draw).set({ notLastYear: 1 }).where(eq(t.draw.id, 'd_xmas')).run();
    return { db, as: await start(db) };
  }

  it('nobody draws last year\'s person again', async () => {
    const last: [string, string][] = [['alex', 'sam'], ['sam', 'robin'], ['robin', 'quinn'], ['quinn', 'alex']];
    const { db, as } = await lastYear(last);
    for (let i = 0; i < 15; i++) {
      expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
      for (const row of db.select().from(t.drawAssignment).where(eq(t.drawAssignment.drawId, 'd_xmas')).all()) {
        const r = openReceiver(KEY, 'd_xmas', row.giverId, row.sealed);
        expect(last.map(([g, x]) => `dp_${g}>dp_${x}`)).not.toContain(`${row.giverId}>${r}`);
      }
    }
  });

  it('whether it may be drawn never depends on last year\'s pairs: the same answer for every last year (review M1)', async () => {
    const lasts: [string, string][][] = [
      [['alex', 'sam'], ['sam', 'robin'], ['robin', 'quinn'], ['quinn', 'alex']],
      [['alex', 'robin'], ['robin', 'alex'], ['sam', 'quinn'], ['quinn', 'sam']],
      [['alex', 'quinn'], ['quinn', 'robin'], ['robin', 'sam'], ['sam', 'alex']],
    ];
    for (const exclusions of [[], [['p_alex', 'p_sam']], [['p_alex', 'p_sam'], ['p_robin', 'p_quinn']]]) {
      const answers = new Set<string>();
      for (const last of lasts) {
        const { as } = await lastYear(last);
        await as('alex').send('PATCH', DRAW, { exclusions });
        const r = await as('alex').send('POST', `${DRAW}/run`);
        answers.add(r.statusCode === 200 ? 'drawn' : r.body);
      }
      expect(answers.size, JSON.stringify(exclusions)).toBe(1);
    }
  });

  it('with the rule on, everyone keeps ⌈n/2⌉+1 people they may draw; off, the same exclusion is fine', async () => {
    const { as } = await lastYear([['alex', 'sam'], ['sam', 'robin'], ['robin', 'quinn'], ['quinn', 'alex']]);
    await as('alex').send('PATCH', DRAW, { exclusions: [['p_alex', 'p_sam']] });
    expect((await as('alex').send('POST', `${DRAW}/run`)).json())
      .toEqual({ error: 'with not last year\'s person on, everyone needs more people they may draw: loosen who shouldn\'t draw whom' });
    await as('alex').send('PATCH', DRAW, { notLastYear: false });
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
  });
});

describe('the reveal', () => {
  /** A drawn draw whose day has passed (last year's), with a reveal date. */
  async function past(revealOn: string | null) {
    const db = home();
    fiveInDraw(db);
    const year = db.select().from(t.draw).get()!.year - 1;
    db.update(t.draw).set({ year, drawnAt: NOW, revealOn }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    return { db, as: await start(db) };
  }

  it('from the reveal date on, the participants and the host see every pair; nobody else does', async () => {
    const { as } = await past(inDays(-1));
    for (const who of ['alex', 'sam', 'robin', 'quinn', 'mia'] as const) {
      const pairs = (await as(who).get(DRAW)).json().pairs as { giver: { id: string }; receiver: { id: string } }[];
      expect(pairs.map((p) => `${p.giver.id}>${p.receiver.id}`).sort(), who).toEqual(IN.map((p, i) => `${p}>${IN[(i + 1) % IN.length]}`).sort());
    }
    for (const who of ['leo', 'uma'] as const) expect((await as(who).get(DRAW)).json()).toMatchObject({ revealed: true, pairs: null });
  });

  it('never by default, and not before its date', async () => {
    for (const revealOn of [null, inDays(1)]) {
      const { as } = await past(revealOn);
      for (const who of PEOPLE) expect((await as(who).get(DRAW)).json(), `${who} ${revealOn}`).toMatchObject({ revealed: false, pairs: null });
    }
  });
});

// --- The surprise on the raw responses ------------------------------------------------------------------------------

const READS = ['/api/notices', '/api/home', '/api/home?for=c_xmas', '/api/celebrations', '/api/celebrations/c_xmas', '/api/celebrations/c_cousins',
  DRAW, '/api/household', '/api/auth/session', '/api/me/passkeys',
  ...['alex', 'sam', 'robin', 'mia', 'leo', 'quinn'].flatMap((p) => [`/api/people/p_${p}`, `/api/people/p_${p}?for=c_xmas`])];

/** Every derangement of the five. */
function derangements(xs: string[]): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  const go = (i: number, used: Set<string>, m: Map<string, string>) => {
    if (i === xs.length) { out.push(new Map(m)); return; }
    for (const r of xs) {
      if (r === xs[i] || used.has(r)) continue;
      used.add(r); m.set(xs[i]!, r);
      go(i + 1, used, m);
      used.delete(r); m.delete(xs[i]!);
    }
  };
  go(0, new Set(), new Map());
  return out;
}
const ALL = derangements(IN);
/** Two assignments that agree on the viewer's own person (if they draw) and differ for everyone else's. */
function twins(viewer: string): [Map<string, string>, Map<string, string>] {
  for (const a of ALL) {
    for (const b of ALL) {
      if (a === b || (IN.includes(viewer) && a.get(viewer) !== b.get(viewer))) continue;
      // differ for every other giver if possible (else as many as can)
      if (IN.filter((g) => g !== viewer).every((g) => a.get(g) !== b.get(g))) return [a, b];
    }
  }
  throw new Error('no twins');
}

interface State {
  opened: (viewer: string) => string[]; together?: 'later'; revealOn?: 'after'; redrawn?: true; claims?: true;
  /** The draw is last year's, its day passed (the gifts made before it). */
  past?: true;
  /** What goes, through the API, before the answers are read (second review M3, L6). */
  then?: 'remove the celebration' | 'remove the draw';
}
const STATES: Record<string, State> = {
  'drawn, nobody opened': { opened: () => [] },
  'drawn, the viewer opened': { opened: (v) => IN.filter((p) => p === v) },
  'drawn, everyone opened': { opened: () => IN },
  'everyone but the viewer opened': { opened: (v) => IN.filter((p) => p !== v) },
  'draw together later': { opened: () => [], together: 'later' },
  'a reveal date set, not reached': { opened: () => IN, revealOn: 'after' },
  'drawn again after some opened': { opened: (v) => IN.filter((p) => p !== v).slice(0, 2), redrawn: true },
  'participants claimed and chipped in on each other\'s lists (review H1)': { opened: () => IN, claims: true },
  'its day passed, reveal never, then its celebration removed (second review M3)': { opened: () => IN, claims: true, past: true, then: 'remove the celebration' },
  'everyone opened and claimed, then the draw removed before its day (second review L6)': { opened: () => IN, claims: true, then: 'remove the draw' },
};

/** Gifts between participants: Quinn and Robin claim, Sam and Robin chip in, Alex starts a group gift. */
function participantGifts(db: Db, NOW = '2026-11-01T10:00:00.000Z') {
  const w = (id: string, personId: string) => ({ id, personId, name: `A wish ${id}`, state: 'listed' as const, position: 0, addedBy: personId, createdAt: NOW, updatedAt: NOW, celebrationId: 'c_xmas' });
  db.insert(t.wish).values([w('w_robin_book', 'p_robin'), w('w_quinn_lamp', 'p_quinn'), w('w_mia_kite', 'p_mia')]).run();
  db.insert(t.claim).values([
    { id: 'cl_1', wishId: 'w_robin_book', giverId: 'p_quinn', quantity: 1, state: 'bought', createdAt: NOW, updatedAt: NOW },
    { id: 'cl_2', wishId: 'w_sam_book', giverId: 'p_robin', quantity: 1, state: 'claimed', createdAt: NOW, updatedAt: NOW },
    { id: 'cl_3', wishId: 'w_mia_kite', giverId: 'p_sam', quantity: 1, state: 'claimed', createdAt: NOW, updatedAt: NOW },
  ]).run();
  db.insert(t.groupGift).values({ wishId: 'w_quinn_lamp', organizerId: 'p_alex', targetMinor: 5000, state: 'open', createdAt: NOW, updatedAt: NOW }).run();
  db.insert(t.share).values([
    { id: 'sh_1', wishId: 'w_quinn_lamp', giverId: 'p_sam', amountMinor: 1000, createdAt: NOW, updatedAt: NOW },
    { id: 'sh_2', wishId: 'w_quinn_lamp', giverId: 'p_robin', amountMinor: 1000, createdAt: NOW, updatedAt: NOW },
  ]).run();
}
/** Every claim, share and organizer in an answer that names a giver, as giver ids. */
function namedGivers(body: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('claims' in o && Array.isArray(o.claims)) for (const c of o.claims as { giver: { id: string } | null }[]) if (c.giver) out.push(c.giver.id);
      if ('givers' in o && Array.isArray(o.givers)) for (const c of o.givers as { giver: { id: string } | null }[]) if (c.giver) out.push(c.giver.id);
      if ('organizer' in o && o.organizer) out.push((o.organizer as { id: string }).id);
      Object.values(o).forEach(walk);
    }
  };
  walk(JSON.parse(body));
  return out;
}

async function answers(viewer: Who, assignment: Map<string, string>, s: State): Promise<Record<string, string>> {
  const db = home();
  fiveInDraw(db);
  const year = db.select().from(t.draw).get()!.year - (s.past ? 1 : 0);
  db.update(t.draw).set({
    // drawn after the gifts were marked, so removing it before its day is allowed (nothing bought since the draw)
    year, drawnAt: '2026-11-02T00:00:00.000Z', occasionOn: s.past ? `${year}-12-24` : null,
    drawTogetherAt: s.together ? '2099-01-01T00:00:00.000Z' : null, revealOn: s.revealOn ? '2099-01-01' : null,
    redrawnAt: s.redrawn ? NOW : null,
  }).where(eq(t.draw.id, 'd_xmas')).run();
  sealAssignments(db, KEY, 'd_xmas', new Map([...assignment].map(([g, r]) => [pid(g), pid(r)])));
  if (s.claims) participantGifts(db, s.past ? `${year}-12-01T10:00:00.000Z` : NOW);
  // the fixture's scarf and pan, given after last year's day, are named as it should be: not this state's question
  if (s.past) { db.delete(t.claim).where(eq(t.claim.id, 'cl_scarf')).run(); db.delete(t.groupGift).where(eq(t.groupGift.wishId, 'w_sam_pan')).run(); }
  for (const p of s.opened(`p_${viewer}`)) db.update(t.drawParticipant).set({ openedAt: NOW }).where(eq(t.drawParticipant.id, pid(p))).run();
  const as = await start(db);
  if (s.then) {
    const r = await as('alex').send('DELETE', s.then === 'remove the draw' ? DRAW : '/api/celebrations/c_xmas');
    expect(r.statusCode, r.body).toBe(204);
  }
  // The morning batch for this moment (ADR 0010): a reveal's notice must not depend on the pairs either.
  built!.morning(new Date());
  const gone = s.then === 'remove the celebration' ? [DRAW, '/api/celebrations/c_xmas', '/api/home?for=c_xmas'] : s.then ? [DRAW] : [];
  const out: Record<string, string> = {};
  for (const u of READS) {
    const r = await as(viewer).get(u);
    expect(r.statusCode, `${viewer} ${u}: ${r.body}`).toBe(gone.some((g) => u === g || u.endsWith('?for=c_xmas')) && s.then === 'remove the celebration' && u.includes('c_xmas') ? (u.startsWith('/api/home') || u.includes('?for=') ? 400 : 404) : gone.includes(u) ? 404 : 200);
    out[u] = `${r.body}\n${JSON.stringify(Object.entries(r.headers).filter(([k]) => k !== 'date').sort())}`;
  }
  return out;
}

describe.each(Object.keys(STATES))('the surprise when %s: each viewer\'s answers do not depend on whom the others drew', (state) => {
  it.each(PEOPLE)('%s', async (who) => {
    const [a, b] = twins(`p_${who}`);
    const one = await answers(who, a, STATES[state]!);
    const two = await answers(who, b, STATES[state]!);
    expect(two).toEqual(one);
    // and the viewer's own person is in their draw answer only once they opened theirs
    const own = STATES[state]!.then ? null : JSON.parse(one[DRAW]!.split('\n')[0]!).mine as { receiver: { id: string } | null } | null;
    const opened = STATES[state]!.opened(`p_${who}`).includes(`p_${who}`);
    if (STATES[state]!.then) { /* the draw is gone */ } else if (IN.includes(`p_${who}`)) expect(own?.receiver?.id ?? null).toBe(opened ? a.get(`p_${who}`) : null);
    else expect(own).toBeNull();
    // and no answer names a participant's gift to another participant, but to its own giver
    for (const [u, body] of Object.entries(one)) {
      const b = body.split('\n')[0]!;
      if (b.startsWith('{"error"')) continue;
      for (const g of namedGivers(b)) expect(g, `${who} ${u}`).toBe(`p_${who}`);
    }
  });
});

describe('the database alone says nothing about who drew whom', () => {
  /** Every row of every table, as stored: sealed bytes as hex. */
  const dump = (db: Db) => {
    const tables = (db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
    return Object.fromEntries(tables.map((n) => [n, (db.$client.prepare(`SELECT rowid AS _rowid, * FROM "${n}" ORDER BY rowid`).all() as Record<string, unknown>[])
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v])))]));
  };
  async function drawn(assignment: Map<string, string>) {
    const db = home();
    fiveInDraw(db);
    db.update(t.draw).set({ drawnAt: NOW }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map([...assignment].map(([g, r]) => [pid(g), pid(r)])));
    return db;
  }

  it('two households with different pairs differ only in the sealed bytes', async () => {
    const [a, b] = twins('nobody');
    const one = dump(await drawn(a)), two = dump(await drawn(b));
    const blank = (d: ReturnType<typeof dump>) => ({ ...d, draw_assignment: d.draw_assignment!.map((r) => ({ ...r, sealed: '…' })), session: [] });
    expect(blank(two)).toEqual(blank(one));
    expect(two.draw_assignment).not.toEqual(one.draw_assignment);
  });

  it('every sealed row has one length and holds no id in the clear; it opens only with the key, for its own giver', async () => {
    const [a] = twins('nobody');
    const db = await drawn(a);
    const rows = db.select().from(t.drawAssignment).all();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.sealed.length)).size).toBe(1);
    for (const p of [...IN, ...IN.map(pid)]) {
      for (const form of [p, Buffer.from(p).toString('hex'), Buffer.from(p).toString('base64').replace(/=+$/, '')]) {
        // the giver column names the giver (who is in the draw is no secret); the sealed bytes name nobody
        expect(rows.map((r) => r.sealed.toString('latin1')).join(), form).not.toContain(form);
      }
    }
    // the key: not in the database; a wrong key opens nothing; a row moved to another giver does not open
    expect(JSON.stringify(dump(db))).not.toContain(TEST_KEY);
    expect(JSON.stringify(dump(db))).not.toContain(KEY.toString('hex'));
    const other = Buffer.alloc(32, 9);
    for (const r of rows) {
      expect(() => openReceiver(other, 'd_xmas', r.giverId, r.sealed)).toThrow();
      expect(openReceiver(KEY, 'd_xmas', r.giverId, r.sealed)).toBe(pid(a.get(`p_${r.giverId.slice(3)}`)!));
    }
    expect(() => openReceiver(KEY, 'd_xmas', rows[1]!.giverId, rows[0]!.sealed)).toThrow();
    expect(() => openReceiver(KEY, 'd_other', rows[0]!.giverId, rows[0]!.sealed)).toThrow();
  });

  it('a row swapped into another giver\'s place is refused, not shown', async () => {
    const [a] = twins('nobody');
    const db = await drawn(a);
    const rows = db.select().from(t.drawAssignment).all();
    const robin = rows.find((r) => r.giverId === 'dp_robin')!;
    db.update(t.drawAssignment).set({ sealed: robin.sealed }).where(eq(t.drawAssignment.giverId, 'dp_sam')).run();
    db.update(t.drawParticipant).set({ openedAt: NOW }).where(eq(t.drawParticipant.id, 'dp_sam')).run();
    const as = await start(db);
    // only Sam's own answer says so; the draw still answers, for Sam and for everyone else
    expect((await as('sam').get(DRAW)).json().mine).toEqual({ opened: true, canOpen: false, receiver: null, receiverGuest: false, unreadable: true });
    expect((await as('robin').get(DRAW)).statusCode).toBe(200);
    // a row cut short (a tag under 16 bytes) does not open either
    expect(() => openReceiver(KEY, 'd_xmas', 'dp_robin', Buffer.concat([robin.sealed.subarray(0, 24), robin.sealed.subarray(28)]))).toThrow();
  });
});

describe('the sealing key', () => {
  it('standalone makes it once in its keys folder (0600), never inside the data folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepsake-keys-'));
    try {
      const cfg = loadConfig({ KEEPSAKE_DATA_DIR: join(dir, 'data'), KEEPSAKE_KEYS_DIR: join(dir, 'keys') });
      const key = sealingKey(cfg)!;
      expect(key).toHaveLength(32);
      const file = join(dir, 'keys', 'sealing.key');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(sealingKey(loadConfig({ KEEPSAKE_DATA_DIR: join(dir, 'data'), KEEPSAKE_KEYS_DIR: join(dir, 'keys') }))).toEqual(key);
      expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')).toEqual(key);
      expect(() => loadConfig({ KEEPSAKE_DATA_DIR: dir, KEEPSAKE_KEYS_DIR: join(dir, 'k') })).toThrow(/must not be in KEEPSAKE_DATA_DIR/);
      expect(() => loadConfig({ KEEPSAKE_DATA_DIR: dir, KEEPSAKE_SEALING_KEY_FILE: join(dir, 'x.key') })).toThrow(/must not be in KEEPSAKE_DATA_DIR/);
      // nor through another name for the data folder: a symlink, or a bind mount (same device and inode)
      mkdirSync(join(dir, 'data'), { recursive: true });
      symlinkSync(join(dir, 'data'), join(dir, 'alias'));
      expect(() => loadConfig({ KEEPSAKE_DATA_DIR: join(dir, 'data'), KEEPSAKE_KEYS_DIR: join(dir, 'alias', 'keys') })).toThrow(/must not be in KEEPSAKE_DATA_DIR/);
      expect(isInside(join(dir, 'data'), join(dir, 'alias', 'k'))).toBe(true);
      expect(isInside(join(dir, 'data'), join(dir, 'keys', 'k'))).toBe(false);
      // homerslab mode makes none: HomersLab gives it, or draws stay off
      expect(loadConfig({ KEEPSAKE_MODE: 'homerslab', KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1', KEEPSAKE_TRUSTED_PROXY: '10.0.0.2', KEEPSAKE_ORIGIN: 'https://k.example', KEEPSAKE_DATA_DIR: dir }).sealingKey).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('gifts between the people of a draw (review H1)', () => {
  it('name no giver to anyone but the giver until the reveal; counts stay; then names come back', async () => {
    const db = home();
    fiveInDraw(db);
    db.update(t.draw).set({ drawnAt: NOW }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    const as = await start(db);
    const w = { personId: 'p_robin', name: 'A puzzle', celebrationId: 'c_xmas' };
    const add = await as('robin').send('POST', '/api/wishes', w);
    const wish = add.json().id as string;
    expect((await as('quinn').send('PUT', `/api/wishes/${wish}/claim`, { quantity: 1 })).statusCode).toBe(200);
    const seen = async (who: Who) => (await as(who).get('/api/people/p_robin')).json().wishes.find((x: { id: string }) => x.id === wish).gift;
    expect((await seen('quinn')).claims).toEqual([{ giver: { id: 'p_quinn', name: 'Quinn' }, guest: null, imported: false, quantity: 1, state: 'claimed', mine: true }]);
    for (const who of ['alex', 'sam', 'uma'] as const) {
      const g = await seen(who);
      expect(g.claims, who).toEqual([{ giver: null, guest: null, imported: false, quantity: 1, state: 'claimed', mine: false }]);
      expect(g.left, who).toBe(0);
    }
    // a giver outside the draw is named as ever
    const other = (await as('robin').send('POST', '/api/wishes', { ...w, name: 'A scarf' })).json().id as string;
    await as('uma').send('PUT', `/api/wishes/${other}/claim`, { quantity: 1 });
    expect((await as('alex').get('/api/people/p_robin')).json().wishes.find((x: { id: string }) => x.id === other).gift.claims[0].giver).toEqual({ id: 'p_uma', name: 'Uma' });
    // after the reveal: named again
    const year = db.select().from(t.draw).get()!.year;
    db.update(t.draw).set({ year: year - 1, revealOn: inDays(-1) }).where(eq(t.draw.id, 'd_xmas')).run();
    expect((await seen('alex')).claims[0].giver).toEqual({ id: 'p_quinn', name: 'Quinn' });
  });
});

describe('the draw\'s day only moves later, and a reveal stays (review H2)', () => {
  it('a celebration with drawn names cannot move earlier; later is fine and audited', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    const d = db.select().from(t.draw).get()!;
    expect(d.occasionOn).toBe(`${d.year}-12-24`);
    expect((await as('alex').send('PATCH', '/api/celebrations/c_xmas', { date: inDays(1), recurrence: 'none' })).json())
      .toEqual({ error: 'the names are drawn: its celebration can only move later' });
    expect((await as('alex').send('PATCH', '/api/celebrations/c_xmas', { date: '2024-12-23' })).json())
      .toEqual({ error: 'the names are drawn: its celebration can only move later' });
    expect((await as('alex').send('PATCH', '/api/celebrations/c_xmas', { date: '2024-12-26' })).statusCode).toBe(200);
    expect((await as('alex').get(DRAW)).json().on).toBe(`${d.year}-12-26`);
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'draw_moved']);
  });

  it('a changed day in the database never brings the day or the reveal forward', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    db.update(t.celebration).set({ date: inDays(-2), recurrence: 'none' }).where(eq(t.celebration.id, 'c_xmas')).run();
    const g = (await as('alex').get(DRAW)).json();
    expect(g.over).toBe(false);
    expect((await as('alex').send('PATCH', DRAW, { revealOn: inDays(0) })).json()).toEqual({ error: 'revealOn: a day after the celebration, or never' });
  });

  it('once revealed, the reveal stays: neither the host nor a later celebration day hides it again', async () => {
    const db = home();
    fiveInDraw(db);
    const year = db.select().from(t.draw).get()!.year - 1;
    db.update(t.draw).set({ year, drawnAt: NOW, occasionOn: `${year}-12-24`, revealOn: inDays(-1) }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    const as = await start(db);
    expect((await as('sam').get(DRAW)).json().revealed).toBe(true);
    expect((await as('alex').send('PATCH', DRAW, { revealOn: null })).json()).toEqual({ error: 'it is revealed: it stays revealed' });
    db.update(t.celebration).set({ date: '2024-12-31' }).where(eq(t.celebration.id, 'c_xmas')).run();
    db.update(t.draw).set({ revealOn: null }).where(eq(t.draw.id, 'd_xmas')).run();
    expect((await as('sam').get(DRAW)).json()).toMatchObject({ revealed: true, pairs: expect.any(Array) });
  });
});

describe('someone in a draw leaving the household (review M2)', () => {
  const drawn = async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    return { db, as };
  };
  it('before the day: the others are drawn again, everyone told if anyone had opened theirs', async () => {
    const { db, as } = await drawn();
    await as('sam').send('POST', `${DRAW}/open`);
    expect((await as('alex').send('DELETE', '/api/people/p_quinn')).statusCode).toBe(204);
    const g = (await as('sam').get(DRAW)).json();
    expect(g).toMatchObject({ drawn: true, total: 4, opened: 0, mine: { opened: false } });
    expect(g.redrawnAt).not.toBeNull();
    expect(db.select().from(t.drawAssignment).all()).toHaveLength(4);
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'redrawn']);
  });
  it('if the others are too few, the draw goes back to not drawn', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('POST', `${DRAW}/run`);
    expect((await as('alex').send('DELETE', '/api/people/p_robin')).statusCode).toBe(204);
    expect((await as('alex').get(DRAW)).json()).toMatchObject({ drawn: false, total: 3 });
    expect(db.select().from(t.drawAssignment).all()).toEqual([]);
    expect(audit(db).map((a) => a.action)).toEqual(['drawn', 'draw_cleared']);
  });
  it('not once someone opened theirs and a gift is bought since: they stay until its day', async () => {
    const { db, as } = await drawn();
    await as('sam').send('POST', `${DRAW}/open`);
    await as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 });
    await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'bought' });
    expect((await as('alex').send('DELETE', '/api/people/p_robin')).json()).toEqual({ error: 'they are in a draw that can no longer change: remove them after its celebration' });
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_robin')).get()).toBeTruthy();
    // and the celebration cannot go either
    expect((await as('alex').send('DELETE', '/api/celebrations/c_xmas')).json()).toEqual({ error: 'a gift is bought already: the draw stays as it is' });
  });
  it('after its day: their rows go; whoever drew them keeps nobody', async () => {
    const db = home();
    fiveInDraw(db);
    const year = db.select().from(t.draw).get()!.year - 1;
    db.update(t.draw).set({ year, drawnAt: NOW, occasionOn: `${year}-12-24` }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    for (const p of IN) db.update(t.drawParticipant).set({ openedAt: NOW }).where(eq(t.drawParticipant.id, pid(p))).run();
    const as = await start(db);
    expect((await as('alex').send('DELETE', '/api/people/p_quinn')).statusCode).toBe(204);
    // IN: alex → sam → robin → quinn → mia → alex: Robin drew Quinn
    expect((await as('robin').get(DRAW)).json().mine).toMatchObject({ opened: true, receiver: null, receiverGuest: false, unreadable: false });
    expect((await as('sam').get(DRAW)).json().mine.receiver).toEqual({ id: 'p_robin', name: 'Robin' });
  });
});

describe('key rotation', () => {
  it('a previous key still opens its rows; rotate-key seals them again with the new one', async () => {
    const db = home();
    fiveInDraw(db);
    db.update(t.draw).set({ drawnAt: NOW }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    db.update(t.drawParticipant).set({ openedAt: NOW }).where(eq(t.drawParticipant.id, 'dp_sam')).run();
    const NEW = Buffer.alloc(32, 11).toString('base64');
    const cfg = standalone({ KEEPSAKE_SEALING_KEY: NEW, KEEPSAKE_SEALING_KEY_PREVIOUS: TEST_KEY });
    const as = await start(db, cfg);
    expect((await as('sam').get(DRAW)).json().mine.receiver).toEqual({ id: 'p_robin', name: 'Robin' });
    const { rotateKey } = await import('../src/draws/draws');
    const { keyring } = await import('../src/draws/sealed');
    expect(rotateKey(db, keyring(cfg))).toEqual({ resealed: 5, unreadable: 0 });
    // without the previous key now
    const as2 = await start(db, standalone({ KEEPSAKE_SEALING_KEY: NEW }));
    expect((await as2('sam').get(DRAW)).json().mine.receiver).toEqual({ id: 'p_robin', name: 'Robin' });
    expect(JSON.stringify(standalone({ KEEPSAKE_SEALING_KEY: NEW, KEEPSAKE_SEALING_KEY_PREVIOUS: TEST_KEY }))).not.toContain(TEST_KEY);
  });
});

describe('second review', () => {
  it('with not last year\'s person on, four are too few', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('PATCH', DRAW, { notLastYear: true });
    expect((await as('alex').send('POST', `${DRAW}/run`)).json()).toEqual({ error: 'with not last year\'s person on, a draw needs at least 5 people' });
  });

  it('a veil keeps gifts unnamed after the celebration goes, and lifts on its reveal date if one had passed', async () => {
    for (const revealOn of [null, 'passed'] as const) {
      const db = home();
      fiveInDraw(db);
      const year = db.select().from(t.draw).get()!.year - 1;
      db.update(t.draw).set({ year, drawnAt: NOW, occasionOn: `${year}-12-24` }).where(eq(t.draw.id, 'd_xmas')).run();
      sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
      participantGifts(db, `${year}-12-01T10:00:00.000Z`);
      if (revealOn) db.update(t.draw).set({ revealOn: inDays(1) }).where(eq(t.draw.id, 'd_xmas')).run();
      const as = await start(db);
      const giverOn = async () => (await as('uma').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === 'w_robin_book').gift.claims[0].giver;
      expect(await giverOn()).toBeNull();
      expect((await as('alex').send('DELETE', '/api/celebrations/c_xmas')).statusCode).toBe(204);
      expect(db.select().from(t.drawVeil).all()).toHaveLength(1);
      expect(Object.keys(db.select().from(t.drawVeil).get()!).sort()).toEqual(['createdAt', 'drawId', 'id', 'on', 'peopleJson', 'revealOn']);
      expect(await giverOn()).toBeNull();
      if (revealOn) {
        db.update(t.drawVeil).set({ revealOn: inDays(-1) }).run();
        expect(await giverOn()).toEqual({ id: 'p_quinn', name: 'Quinn' });
      }
    }
  });

  it('someone taken out of a drawn draw: the gifts made under it stay unnamed', async () => {
    const db = home();
    fiveInDraw(db);
    db.update(t.draw).set({ drawnAt: '2026-11-02T00:00:00.000Z' }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    participantGifts(db);
    db.update(t.drawParticipant).set({ openedAt: NOW }).where(eq(t.drawParticipant.id, 'dp_quinn')).run();
    const as = await start(db);
    const r = await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] });
    expect(r.statusCode, r.body).toBe(200);
    const g = (await as('uma').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === 'w_robin_book').gift;
    expect(g.claims[0].giver).toBeNull(); // Quinn's claim, made while Quinn was in the draw
  });

  it.each([['America/Los_Angeles', 'named'], ['Pacific/Auckland', 'unnamed']] as const)('a gift\'s day is the household\'s (%s)', async (tz, _x) => {
    const db = home();
    fiveInDraw(db);
    const year = db.select().from(t.draw).get()!.year;
    const day = `${year}-12-24`;
    db.update(t.draw).set({ drawnAt: NOW, occasionOn: day }).where(eq(t.draw.id, 'd_xmas')).run();
    sealAssignments(db, KEY, 'd_xmas', new Map(IN.map((p, i) => [pid(p), pid(IN[(i + 1) % IN.length]!)])));
    // Los Angeles: 19:00 on the day itself (03:00Z the next day): still the day, unnamed.
    // Auckland: 00:30 the next day (11:30Z on the day): after the day, named.
    const at = tz === 'America/Los_Angeles' ? `${year}-12-25T03:00:00.000Z` : `${year}-12-24T11:30:00.000Z`;
    participantGifts(db, at);
    const as = await start(db, standalone({ KEEPSAKE_TZ: tz }));
    const g = (await as('uma').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === 'w_robin_book').gift;
    expect(g.claims[0].giver).toEqual(tz === 'America/Los_Angeles' ? null : { id: 'p_quinn', name: 'Quinn' });
  });

  it('a one-off moved into next year does not let a second draw take a drawn one\'s place', async () => {
    const db = home();
    const as = await start(db);
    await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] });
    await as('alex').send('POST', `${DRAW}/run`);
    const year = db.select().from(t.draw).get()!.year;
    expect((await as('alex').send('PATCH', '/api/celebrations/c_xmas', { date: `${year + 1}-01-06`, recurrence: 'none' })).statusCode).toBe(200);
    expect((await as('alex').send('POST', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] })).json()).toEqual({ error: 'this celebration has a draw already' });
    expect(db.select().from(t.draw).all()).toHaveLength(1);
  });

  it('someone in a drawn draw who becomes a kid stays in it; a host who becomes a kid hands the draw to the admins', async () => {
    const db = home();
    fiveInDraw(db);
    db.update(t.draw).set({ kidsDraw: 0 }).where(eq(t.draw.id, 'd_xmas')).run();
    db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, 'dp_mia')).run();
    const as = await start(db);
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    // Quinn becomes a kid: still in the draw, and the host can still change the budget
    db.update(t.person).set({ role: 'kid' }).where(eq(t.person.id, 'p_quinn')).run();
    expect((await as('alex').send('PATCH', DRAW, { budgetMinor: 2000 })).statusCode).toBe(200);
    expect((await as('alex').get(DRAW)).json().people.map((p: { id: string }) => p.id)).toContain('p_quinn');
    // the cousins' exchange: hosted by Sam, who becomes a kid; Alex (an admin) runs its draw then
    db.update(t.celebration).set({ hostId: 'p_sam' }).where(eq(t.celebration.id, 'c_cousins')).run();
    db.update(t.person).set({ role: 'kid' }).where(eq(t.person.id, 'p_sam')).run();
    expect((await as('alex').send('POST', '/api/celebrations/c_cousins/draw', { people: ['p_alex', 'p_robin'] })).statusCode).toBe(201);
    expect((await as('sam').get('/api/celebrations/c_cousins/draw')).json().canManage).toBe(false);
  });
});

describe('a veil follows its draw while the draw lives on (third review L8)', () => {
  afterEach(() => { vi.useRealTimers(); });
  /** Five in the draw, drawn through the API; Robin has a Christmas wish. Returns the year and helpers. */
  async function setUp(revealOn: (y: number) => string | null) {
    const db = home();
    fiveInDraw(db);
    let as = await start(db);
    const Y = db.select().from(t.draw).get()!.year;
    if (revealOn(Y)) expect((await as('alex').send('PATCH', DRAW, { revealOn: revealOn(Y) })).statusCode).toBe(200);
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    const wish = (await as('robin').send('POST', '/api/wishes', { personId: 'p_robin', name: 'A puzzle', celebrationId: 'c_xmas' })).json().id as string;
    const giver = async () => (await as('uma').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === wish).gift.claims[0]?.giver;
    const at = async (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); as = await start(db); };
    return { db, Y, wish, giver, at, as: () => as };
  }

  it('P1: re-drawn, a claim under the new pairs, then revealed: the claim is named after the reveal', async () => {
    const x = await setUp(() => null);
    // a correction: Mia out (re-draws, writes a veil while the draw lives on)
    expect((await x.as()('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_quinn'], kidsDraw: false })).statusCode).toBe(200);
    expect(x.db.select().from(t.drawVeil).all()).toHaveLength(1);
    await x.as()('quinn').send('PUT', `/api/wishes/${x.wish}/claim`, { quantity: 1 });
    expect(await x.giver()).toBeNull();
    expect((await x.as()('alex').send('PATCH', DRAW, { revealOn: `${x.Y}-12-26` })).statusCode).toBe(200);
    await x.at(`${x.Y}-12-27T12:00:00.000Z`);
    expect((await x.as()('sam').get(DRAW)).json().pairs).toHaveLength(4);
    expect(await x.giver()).toEqual({ id: 'p_quinn', name: 'Quinn' });
  });

  it('P2: someone taken out, then the host chooses never: the old pair stays hidden after the old reveal date', async () => {
    const x = await setUp((Y) => `${Y}-12-26`);
    await x.as()('quinn').send('POST', `${DRAW}/open`);
    await x.as()('quinn').send('PUT', `/api/wishes/${x.wish}/claim`, { quantity: 1 });
    expect((await x.as()('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] })).statusCode).toBe(200);
    expect((await x.as()('alex').send('PATCH', DRAW, { revealOn: null })).statusCode).toBe(200);
    await x.at(`${x.Y}-12-27T12:00:00.000Z`);
    expect((await x.as()('sam').get(DRAW)).json().revealed).toBe(false);
    expect(await x.giver()).toBeNull();
  });

  it('P3: someone taken out, then the celebration moved later: the veil waits for the new day', async () => {
    const x = await setUp((Y) => `${Y}-12-26`);
    await x.as()('quinn').send('POST', `${DRAW}/open`);
    await x.as()('quinn').send('PUT', `/api/wishes/${x.wish}/claim`, { quantity: 1 });
    expect((await x.as()('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] })).statusCode).toBe(200);
    expect((await x.as()('alex').send('PATCH', '/api/celebrations/c_xmas', { date: '2024-12-31' })).statusCode).toBe(200);
    await x.at(`${x.Y}-12-28T12:00:00.000Z`);
    expect(await x.giver()).toBeNull();
    await x.at(`${x.Y + 1}-01-02T12:00:00.000Z`);
    expect((await x.as()('sam').get(DRAW)).json().revealed).toBe(true);
    expect(await x.giver()).toEqual({ id: 'p_quinn', name: 'Quinn' });
  });

  it('when the draw goes, its veils take its day and reveal date as they are then', async () => {
    const x = await setUp((Y) => `${Y}-12-26`);
    await x.as()('quinn').send('POST', `${DRAW}/open`);
    expect((await x.as()('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'] })).statusCode).toBe(200);
    expect((await x.as()('alex').send('PATCH', DRAW, { revealOn: null })).statusCode).toBe(200);
    expect((await x.as()('alex').send('DELETE', DRAW)).statusCode).toBe(204);
    const veils = x.db.select().from(t.drawVeil).all();
    expect(veils).toHaveLength(2);
    for (const v of veils) expect(v).toMatchObject({ drawId: null, revealOn: null, on: `${x.Y}-12-24` });
  });

  it('nit: someone who became a kid before the names are drawn is refused without "Kids draw too"', async () => {
    const db = home();
    db.update(t.draw).set({ kidsDraw: 0 }).where(eq(t.draw.id, 'd_xmas')).run();
    db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, 'dp_mia')).run();
    fiveInDraw(db);
    db.update(t.person).set({ role: 'kid' }).where(eq(t.person.id, 'p_quinn')).run();
    const as = await start(db);
    expect((await as('alex').send('POST', `${DRAW}/run`)).json()).toEqual({ error: 'people: a kid draws only when kids draw too' });
  });
});

describe('a draw that fails (issue #13, 2)', () => {
  it('a refusal keeps what it wrote before refusing; any other failure undoes everything, its try too', async () => {
    const db = home();
    fiveInDraw(db);
    const as = await start(db);
    const tries = () => db.select().from(t.drawTry).all().length;
    // A refusal: its try is counted and audited.
    await as('alex').send('PATCH', DRAW, { people: ['p_alex', 'p_sam', 'p_robin'] });
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(409);
    expect([tries(), audit(db).filter((a) => a.action === 'draw_refused').length]).toEqual([1, 1]);
    await as('alex').send('PATCH', DRAW, { people: IN });
    const before = { tries: tries(), audit: audit(db).length };
    // Not a refusal: the sealed rows cannot be written (a broken disk, a bug).
    db.$client.exec(`CREATE TRIGGER broken BEFORE INSERT ON draw_assignment BEGIN SELECT RAISE(ABORT, 'broken'); END`);
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(500);
    expect({ tries: tries(), audit: audit(db).length, pending: db.select().from(t.pendingNotice).all() }).toEqual({ ...before, pending: [] });
    db.$client.exec('DROP TRIGGER broken');
    expect((await as('alex').send('POST', `${DRAW}/run`)).statusCode).toBe(200);
    expect(tries()).toBe(before.tries + 1);
  });
});
