// The Gate's surprise review (issue #6, comment 7180972935): each red-team probe kept as a test, the other way round.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';
import { Pusher } from '../src/push/push';
import { as, makeHome, ok, pin, setNow, type Home } from './m4';

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
    // The organizer may set any target; nothing refuses it for what is in.
    expect((await as(h, 'alex').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 100 })).statusCode).toBe(200);
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
