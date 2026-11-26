// The Gate re-attack's probes on PR #15 (surprise R1–R4), kept as tests: each one failed before its fix.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household, sessionCookie, standalone, withDraws } from './helpers';
import { as, makeHome, ok, pin, setNow, type Home } from './m4';

const T0 = new Date('2026-12-01T10:00:00.000Z');
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async () => { const h = await makeHome(); homes.push(h); return h; };
const apps: BuiltApp[] = [];
afterEach(async () => { setNow(T0); for (const h of homes.splice(0)) await h.built.app.close(); for (const a of apps.splice(0)) await a.app.close(); });

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

describe('R2: while the draw is sealed after a reset, nothing of the person\'s own points at whom they drew', () => {
  it('Sam opened, claimed, chipped in, wrote an idea and asked his receiver; reset and unconfirmed, no answer marks any of it his', async () => {
    const NOW = new Date().toISOString();
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    // Robin is Mia's parent here, so Sam may write ideas and ask questions for whoever he draws.
    db.update(t.manager).set({ managerId: 'p_robin' }).where(eq(t.manager.kidId, 'p_mia')).run();
    const mates = ['p_alex', 'p_robin', 'p_mia'];
    for (const p of mates) {
      db.insert(t.wish).values({ id: `w_${p}_xmas`, personId: p, celebrationId: 'c_xmas', name: 'A puzzle', quantity: 3, state: 'listed', position: 9, addedBy: p, createdAt: NOW, updatedAt: NOW }).run();
      db.insert(t.wish).values({ id: `w_${p}_bike`, personId: p, celebrationId: 'c_xmas', name: 'A bike', quantity: 1, state: 'listed', position: 10, addedBy: p, createdAt: NOW, updatedAt: NOW }).run();
    }
    db.insert(t.passkey).values({ id: 'pk-p_sam', personId: 'p_sam', publicKey: Buffer.from([1]), label: 'x', createdAt: NOW }).run();
    const built = await buildApp(standalone(), db, { webauthn: fakeWebAuthn() }); apps.push(built);
    const fresh = (p: string) => `__Host-keepsake_session=${createSession(db, p, p === 'p_alex' ? 'pk1' : `pk-${p}`).token}`;
    const send = (method: 'POST' | 'PUT' | 'GET' | 'PATCH', url: string, cookie: string, payload?: object) => built.app.inject({ method, url, payload, headers: { origin: ORIGIN, cookie } });
    await ok(send('POST', '/api/celebrations/c_xmas/draw/run', fresh('p_alex')));
    const sam0 = fresh('p_sam');
    await ok(send('POST', '/api/celebrations/c_xmas/draw/open', sam0));
    const receiver = (await ok(send('GET', '/api/celebrations/c_xmas/draw', sam0))).json().mine.receiver.id as string;
    await ok(send('PUT', `/api/wishes/w_${receiver}_xmas/claim`, sam0, { quantity: 1 }));
    await ok(send('POST', `/api/wishes/w_${receiver}_bike/group`, sam0, { targetMinor: 20000 }));
    await ok(send('PUT', `/api/wishes/w_${receiver}_bike/group/share`, sam0, { amountMinor: 500 }));
    await ok(send('POST', `/api/people/${receiver}/ideas`, sam0, { text: 'Gloves' }));
    await ok(send('POST', `/api/people/${receiver}/questions`, sam0, { text: 'Which size?' }));
    // The reset (one admin, a day later), the invite, the enrolment: an admin is now Sam on a new device.
    await send('POST', '/api/people/p_sam/passkeys/reset', fresh('p_alex'));
    db.update(t.passkeyReset).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).run();
    await ok(send('POST', '/api/people/p_sam/passkeys/reset', fresh('p_alex')));
    const inv = (await ok(send('POST', '/api/people/p_sam/invites', fresh('p_alex')))).json();
    const o = (await send('POST', '/api/auth/enrol/options', '', { token: inv.url.split('#')[1] })).json();
    await ok(send('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: 'cred-new', challenge: o.options.challenge }, label: 'New phone' }));
    const pk = db.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).get()!.id;
    const sam = () => `__Host-keepsake_session=${createSession(db, 'p_sam', pk).token}`;
    expect((await ok(send('GET', '/api/celebrations/c_xmas/draw', sam()))).json().mine).toMatchObject({ sealed: true, receiver: null });
    const pages = async () => Promise.all(mates.map(async (p) => (await ok(send('GET', `/api/people/${p}`, sam()))).body));
    for (const [i, body] of (await pages()).entries()) {
      expect([mates[i], body.includes('"mine":true'), body.includes('"canManage":true'), body.includes('Which size?'), body.includes('"myShareMinor":500')]).toEqual([mates[i], false, false, false, false]);
    }
    expect((await ok(send('GET', '/api/home', sam()))).json()).toMatchObject({ gave: [], suggested: [] });
    // After the day (a draw revealed never), a gift he gave is not among his, and its thank-you does not reach him.
    db.update(t.claim).set({ state: 'given', givenOn: '2026-12-20' }).where(eq(t.claim.giverId, 'p_sam')).run();
    setNow(new Date('2026-12-27T10:00:00.000Z'));
    expect((await ok(send('GET', '/api/home', sam()))).json()).toMatchObject({ gave: [], thanked: [] });
    // Confirmed: all of it is his again.
    await ok(send('POST', '/api/me/reset/confirm', sam()));
    expect((await ok(send('GET', '/api/home', sam()))).json().gave).toHaveLength(1);
  });
});

describe('R1: "enough" is no quick oracle: the target is locked once anyone chipped in, and a share changes 3 times a day', () => {
  const group = async (h: Home) => (await ok(as(h, 'alex').get('/api/people/p_sam'))).json().wishes.find((w: { id: string }) => w.id === 'w_sam_pan').gift.group as { enough: boolean; targetMinor: number };
  it.each([3100, 4999, 1])('Robin puts in %i; Alex\'s binary search over his own share stops after 3 writes a day', async (robin) => {
    const h = await home();
    await ok(as(h, 'robin').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: robin }));
    const target = (await group(h)).targetMinor;
    let lo = 1, hi = target, writes = 0, refused = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await as(h, 'alex').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: mid });
      if (r.statusCode !== 200) { refused++; expect(r.json()).toEqual({ error: 'you changed your share 3 times today: again tomorrow' }); break; }
      writes++;
      if ((await group(h)).enough) hi = mid; else lo = mid + 1;
    }
    expect([writes, refused]).toEqual([3, 1]);
    // Taking it back is a change too, and counts the same day; the next day there are 3 again.
    expect((await as(h, 'alex').send('DELETE', '/api/wishes/w_sam_pan/group/share')).statusCode).toBe(409);
    setNow(new Date('2026-12-02T10:00:00.000Z'));
    for (const p of ['alex', 'robin'] as const) h.cookies[p] = sessionCookie(h.db, `p_${p}`);
    expect((await as(h, 'alex').send('DELETE', '/api/wishes/w_sam_pan/group/share')).statusCode).toBe(204);
  });

  it.each([3100, 7999])('Robin puts in %i; Alex (the organizer) cannot move the target down to find the total', async (robin) => {
    const h = await home();
    await ok(as(h, 'robin').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: robin }));
    const r = await as(h, 'alex').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 4000 });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'someone has chipped in: only whoever started it raises the target' }]);
    // Only up, and only by whoever started it.
    expect((await as(h, 'robin').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 9000 })).statusCode).toBe(403);
    expect((await ok(as(h, 'alex').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 9000 }))).json().gift.group.targetMinor).toBe(9000);
    expect((await as(h, 'alex').send('PATCH', '/api/wishes/w_sam_pan/group', { targetMinor: 8999 })).statusCode).toBe(409);
  });
});
