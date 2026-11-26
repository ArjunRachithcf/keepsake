// The Gate's surprise review (issue #6, comment 7180972935): each red-team probe kept as a test, the other way round.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';
import { Pusher } from '../src/push/push';
import { buildApp } from '../src/app';
import { hl, homerslab, household, sessionCookie } from './helpers';
import { as, countingTransport, makeHome, ok, pin, reads, setNow, withDevices, type Home } from './m4';

const T0 = new Date('2026-12-01T10:00:00.000Z');
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async () => { const h = await makeHome({ KEEPSAKE_EGRESS: 'on' }); homes.push(h); return h; };
afterEach(async () => { setNow(T0); for (const h of homes.splice(0)) await h.built.app.close(); });

describe('L2 (probe P4): once a gift reached her, Robin still orders her list', () => {
  it('the order of exactly what she sees is taken; the received wish keeps its place', async () => {
    const h = await home();
    for (const name of ['One', 'Two']) await ok(as(h, 'robin').send('POST', '/api/wishes', { personId: 'p_robin', name, quantity: 1, mostWanted: false, celebrationId: null, link: null, priceMinor: null, note: null }));
    const list = async () => ((await ok(as(h, 'robin').get('/api/home'))).json().wishes as { id: string }[]).map((w) => w.id);
    const ids = await list();
    expect(ids).toHaveLength(2); // the received scarf is gone from her list
    const scarf = () => h.db.select().from(t.wish).where(eq(t.wish.id, 'w_robin_scarf')).get()!.position;
    const before = scarf();
    const r = await as(h, 'robin').send('PUT', '/api/people/p_robin/wish-order', { wishIds: [...ids].reverse() });
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect([await list(), scarf()]).toEqual([[...ids].reverse(), before]);
    // Still each of what she sees, once.
    expect((await as(h, 'robin').send('PUT', '/api/people/p_robin/wish-order', { wishIds: [ids[0]] })).statusCode).toBe(400);
    expect((await as(h, 'robin').send('PUT', '/api/people/p_robin/wish-order', { wishIds: [...ids, 'w_robin_scarf'] })).statusCode).toBe(400);
  });
});

describe('L3 (probe P8): "not each other\'s amounts" holds with two sharers', () => {
  const pan = async (h: Home, who: 'alex' | 'quinn') => (await ok(as(h, who).get('/api/people/p_sam'))).json().wishes.find((w: { id: string }) => w.id === 'w_sam_pan').gift.group;
  it('Alex reads no total: only whether it is enough, and his own share; the same whatever Robin put in', async () => {
    const seen: string[] = [];
    for (const amount of [3100, 1000]) {
      const h = await home();
      await ok(as(h, 'robin').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: amount }));
      const g = await pan(h, 'alex');
      expect(g).not.toHaveProperty('totalMinor');
      expect([g.givers.map((x: { giver: { name: string } }) => x.giver.name), g.enough, g.myShareMinor]).toEqual([['Robin'], false, null]);
      seen.push(JSON.stringify(g));
    }
    expect(seen[0]).toBe(seen[1]);
  });

  it('chipping in is refused only for a share above the target itself, never by what others put in (no probing the total)', async () => {
    const h = await home();
    await ok(as(h, 'robin').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: 3100 }));
    // 3100 + 4901 is over the 8000 target: no 409 that would tell Alex where Robin's amount ends.
    expect((await as(h, 'alex').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: 4901 })).statusCode).toBe(200);
    expect((await pan(h, 'alex')).enough).toBe(true);
    expect((await as(h, 'alex').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: 8001 })).statusCode).toBe(409);
    // The organizer raises the target; nothing refuses it for what is in (lowering it is refused once anyone chipped in,
    // whatever is in: Gate re-attack R1).
    expect((await as(h, 'alex').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 100_000 })).statusCode).toBe(200);
  });
});

describe('L4 (probe P7): what is deleted leaves the database files', () => {
  it('a question its asker took back: neither its text nor its asker stays in the file or the WAL after the next tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepsake-del-'));
    try {
      const db = openDb(join(dir, 'keepsake.sqlite'));
      expect(db.$client.pragma('secure_delete', { simple: true })).toBe(1);
      db.insert(t.person).values([{ id: 'p_quinn_asker', name: 'Quinn', role: 'adult', createdAt: T0.toISOString() }, { id: 'p_robin', name: 'Robin', role: 'adult', createdAt: T0.toISOString() }]).run();
      db.$client.pragma('wal_checkpoint(TRUNCATE)');
      db.insert(t.question).values({ id: 'q1', personId: 'p_robin', askerId: 'p_quinn_asker', text: 'TAKEN-BACK-QUESTION', askedAt: 'x', deliverAt: 'y', state: 'open' }).run();
      db.delete(t.question).run();
      db.delete(t.person).where(eq(t.person.id, 'p_quinn_asker')).run();
      await new Pusher(db, null).tick();
      const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
      expect([bytes.includes('TAKEN-BACK-QUESTION'), bytes.includes('p_quinn_asker')]).toEqual([false, false]);
      db.$client.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('H2 (probe P3): what the sheet says was bought never shows on its person\'s list by its absence', () => {
  const csv = (status: string) => [
    'Person,Item,Link,Priority,Status,Bought by,Price,Occasion,Notes',
    'Robin,Wool gloves,,,,,,Christmas,',
    `Robin,A kettle,,,${status},Sam,,Christmas,`,
    `Robin,A teapot,,,${status},Someone else,,Christmas,`,
    'Robin,A lamp,,,Reserved,Sam,,Christmas,',
  ].join('\n');
  // The import's wishes get new ids (ULIDs, from the moment and chance): numbered in order of appearance instead.
  const plain = (snap: Record<string, string>) => {
    const ids = new Map<string, string>();
    return JSON.stringify(snap).replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, (u) => { if (!ids.has(u)) ids.set(u, `ulid${ids.size}`); return ids.get(u)!; });
  };
  it('Robin\'s every answer is the same bytes whatever the Status column says; Sam sees the kettle bought, the teapot as an imported reservation', async () => {
    const robin: string[] = [];
    for (const status of ['', 'Reserved', 'Bought', 'Given', 'Purchased']) {
      const h = await home();
      await ok(as(h, 'alex').send('POST', '/api/import', { csv: csv(status), people: {}, occasions: {} }));
      robin.push(plain(await reads(h, 'robin')));
      const gifts = ((await ok(as(h, 'sam').get('/api/people/p_robin'))).json().wishes as { name: string; gift: { claims: { state: string; imported: boolean; mine: boolean }[] } }[])
        .filter((w) => ['A kettle', 'A teapot'].includes(w.name)).map((w) => [w.name, w.gift.claims.map((c) => [c.state, c.imported, c.mine])]);
      if (status === 'Bought') expect(gifts).toEqual([['A kettle', [['bought', false, true]]], ['A teapot', [['bought', true, false]]]]);
      // Given: gone from the givers' lists ("given once, gone everywhere"); kept as given claims, revealed after Christmas.
      if (status === 'Given') {
        expect(gifts).toEqual([]);
        const claims = h.db.select().from(t.claim).where(eq(t.claim.state, 'given')).all().filter((c) => c.id !== 'cl_scarf');
        expect(claims.map((c) => [c.giverId, c.imported, c.givenOn, c.occasionOn]).sort()).toEqual([['p_sam', 0, '2026-12-01', '2026-12-24'], [null, 1, '2026-12-01', '2026-12-24']].sort());
      }
    }
    expect(robin.slice(1)).toEqual([robin[0], robin[0], robin[0], robin[0]]);
    expect(robin[0]).toContain('A kettle');
  });
});

describe('H1 (probes P1, P2): whose phone lights up after a thank-you or an answer names nobody', () => {
  const BATCH = new Date('2026-12-02T08:00:00.000Z');
  const NEXT = new Date('2026-12-03T08:00:00.000Z');
  const pushedSince = async (h: Home) => { await h.built.pusher.idle(); const m = Object.fromEntries(h.pushes); h.pushes.clear(); return m; };
  /** The batch at `at`, with the household signed in again (sessions idle out after 7 days). */
  const batch = async (h: Home, at: Date) => { setNow(at); h.built.morning(at); return pushedSince(h); };

  it.each(['p_alex', 'p_sam'])('P1: the scarf given by %s, unnamed: nobody is pushed after Robin thanks; at the batch, every device, the same', async (giver) => {
    const h = await home();
    h.db.update(t.claim).set({ giverId: giver, named: 0 }).where(eq(t.claim.id, 'cl_scarf')).run();
    await pushedSince(h);
    const home1 = (await ok(as(h, 'robin').get('/api/home'))).json();
    expect(home1.thanks.map((x: { wish: { id: string }; from: unknown[] }) => [x.wish.id, x.from])).toEqual([['w_robin_scarf', []]]);
    await ok(as(h, 'robin').send('PUT', '/api/wishes/w_robin_scarf/thanks', { text: 'Thank you!' }));
    // The queue's next ticks: nobody's phone.
    expect(await pushedSince(h)).toEqual({});
    const every = Object.fromEntries([...new Set(h.db.select().from(t.pushSubscription).all().map((s) => s.personId))].map((p) => [p, 1]));
    expect(await batch(h, BATCH)).toEqual(every);
    // The giver reads it from then on.
    expect(h.db.select().from(t.notice).where(eq(t.notice.kind, 'thanked')).all().map((n) => n.personId)).toEqual([giver]);
  });

  it.each(['quinn', 'uma', 'gR'] as const)('P2: asked by %s: nobody is pushed after Robin answers; at the next batch, every device, the same', async (asker) => {
    const h = await home();
    const url = asker.startsWith('g') ? '/api/guest/questions' : '/api/people/p_robin/questions';
    const q = (await ok(as(h, asker).send('POST', url, { text: 'Leather or wool?' }))).json().id;
    await batch(h, BATCH);
    for (const p of ['robin', 'quinn', 'uma'] as const) h.cookies[p] = sessionCookie(h.db, `p_${p}`);
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'Wool' }));
    expect(await pushedSince(h)).toEqual({});
    const every = Object.fromEntries([...new Set(h.db.select().from(t.pushSubscription).all().map((s) => s.personId))].map((p) => [p, 1]));
    expect(await batch(h, NEXT)).toEqual(every);
  });
});

describe('L5: under HomersLab, nobody the edge has not brought for 30 days is pushed', () => {
  it('a request through the edge marks its person seen (at most once an hour); someone unseen for 30 days gets no push', async () => {
    const db = household();
    db.update(t.person).set({ externalId: 'hl-robin' }).where(eq(t.person.id, 'p_robin')).run();
    const pushes = withDevices(db);
    const built = await buildApp(homerslab('127.0.0.1', { KEEPSAKE_EGRESS: 'on' }), db, { pushTransport: countingTransport(pushes) });
    try {
      const seen = () => db.select().from(t.person).where(eq(t.person.id, 'p_robin')).get()!.lastSeenAt;
      expect(seen()).toBeNull();
      await ok(built.app.inject({ url: '/api/home', headers: hl('hl-robin', 'Robin', 'adult'), remoteAddress: '127.0.0.1' }));
      expect(seen()).toBe(T0.toISOString());
      setNow(new Date(T0.getTime() + 31 * 86_400_000));
      // Every device stays confirmed: only the person's absence counts.
      db.update(t.pushSubscription).set({ confirmedAt: new Date().toISOString() }).run();
      built.pusher.wake(['p_robin', 'p_sam']);
      await built.pusher.idle();
      expect(Object.fromEntries(pushes)).toEqual({ p_sam: 1 });
      expect(db.select().from(t.pendingPush).all()).toEqual([]);
      // Back through the edge: pushed again.
      await ok(built.app.inject({ url: '/api/home', headers: hl('hl-robin', 'Robin', 'adult'), remoteAddress: '127.0.0.1' }));
      built.pusher.wake(['p_robin']);
      await built.pusher.idle();
      expect(pushes.get('p_robin')).toBe(1);
    } finally { await built.app.close(); }
  });
});
