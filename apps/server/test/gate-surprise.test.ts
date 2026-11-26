// The Gate's surprise review (issue #6, comment 7180972935): each red-team probe kept as a test, the other way round.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as t from '../src/db/schema';
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
