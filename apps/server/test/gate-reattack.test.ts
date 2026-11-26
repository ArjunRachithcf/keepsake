// The Gate re-attack's probes on PR #15 (surprise R1–R4), kept as tests: each one failed before its fix.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as t from '../src/db/schema';
import { sessionCookie } from './helpers';
import { as, makeHome, ok, pin, setNow, type Home } from './m4';

const T0 = new Date('2026-12-01T10:00:00.000Z');
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async () => { const h = await makeHome(); homes.push(h); return h; };
afterEach(async () => { setNow(T0); for (const h of homes.splice(0)) await h.built.app.close(); });

describe('R3: an imported reservation that was given stays given', () => {
  it('Robin received an imported Given gift (her thank-yous show it); an admin\'s release is refused and it stays off her list', async () => {
    const h = await home();
    const csv = ['Person,Item,Link,Priority,Status,Bought by,Price,Occasion,Notes', 'Robin,A teapot,,,Given,Grandpa Joe,,Christmas,', 'Robin,A scarf,,,Reserved,Grandpa Joe,,Christmas,'].join('\n');
    await ok(as(h, 'alex').send('POST', '/api/import', { csv, people: {}, occasions: {} }));
    const named = (name: string) => h.db.select().from(t.wish).where(eq(t.wish.name, name)).get()!.id;
    const scarf = named('A scarf');
    // Before the day, as after it, a given one stays: only one nobody has given yet is released.
    const teapot = named('A teapot');
    expect((await as(h, 'alex').send('DELETE', `/api/wishes/${teapot}/imported-claim`)).json()).toEqual({ error: 'it was given: the reservation stays' });
    setNow(new Date('2026-12-26T10:00:00.000Z'));
    for (const p of ['alex', 'robin'] as const) h.cookies[p] = sessionCookie(h.db, `p_${p}`);
    const before = (await ok(as(h, 'robin').get('/api/home'))).body;
    expect(JSON.parse(before).thanks.some((x: { wish: { id: string } }) => x.wish.id === teapot)).toBe(true);
    const rel = await as(h, 'alex').send('DELETE', `/api/wishes/${teapot}/imported-claim`);
    expect([rel.statusCode, rel.json()]).toEqual([409, { error: 'it was given: the reservation stays' }]);
    expect((await ok(as(h, 'robin').get('/api/home'))).body).toBe(before);
    expect((await as(h, 'alex').send('DELETE', `/api/wishes/${scarf}/imported-claim`)).statusCode).toBe(204);
  });
});
