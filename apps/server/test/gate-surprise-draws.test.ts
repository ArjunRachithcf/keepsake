// The Gate's surprise review (issue #6, comment 7180972935), M1 (probe P5): a draw guest's unnamed claim never goes
// when their link is revoked, the wish moves, the names are drawn again or a kid edits the wish; while a draw or a veil
// covers it, it stays a nobody's claim that still counts, so nothing points at whom the guest drew.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, household, sessionCookie, standalone, withDraws } from './helpers';
import { ok } from './m4';

const apps: BuiltApp[] = [];
afterEach(async () => { vi.useRealTimers(); for (const a of apps.splice(0)) await a.app.close(); });
const cookieOf = (r: { headers: Record<string, unknown> }) => String([r.headers['set-cookie']].flat()[0]).split(';')[0]!;
async function start(db: Db) {
  const built = await buildApp(standalone(), db);
  apps.push(built);
  const inject = built.app.inject.bind(built.app);
  const person = (id: string) => ({
    get: (url: string) => inject({ url, headers: { cookie: sessionCookie(db, id) } }),
    send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => inject({ method, url, payload, headers: { cookie: sessionCookie(db, id), origin: ORIGIN } }),
  });
  const exchange = (url: string) => inject({ method: 'POST', url: '/api/guest/session', payload: { token: url.split('#')[1] }, headers: { origin: ORIGIN } });
  const guest = (r: { headers: Record<string, unknown>; json: () => { link: string } }) => {
    const headers = { cookie: cookieOf(r), 'x-keepsake-link': r.json().link };
    return { send: (method: 'POST' | 'PUT', url: string, payload?: object) => inject({ method, url, payload, headers: { ...headers, origin: ORIGIN } }) };
  };
  return { person, exchange, guest, built };
}

/** Christmas drawn with a cousin by link; every puzzle claimed once, unnamed, by a household participant; the cousin claims their person's. */
async function drawnWithCousin() {
  const db = withDraws(household());
  db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
  for (const p of ['alex', 'sam', 'robin', 'mia']) db.insert(t.wish).values({ id: `w_${p}_xmas`, personId: `p_${p}`, celebrationId: 'c_xmas', name: 'A puzzle', quantity: 3, state: 'listed', position: 9, addedBy: `p_${p}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }).run();
  const s = await start(db);
  const made = (await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' }))).json();
  await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
  const g = s.guest(await s.exchange(made.url));
  await ok(g.send('PUT', '/api/guest/name', { name: 'Ada' }));
  const target = (await ok(g.send('POST', '/api/guest/draw/open'))).json().person.id as string;
  for (const p of ['p_alex', 'p_sam', 'p_robin', 'p_mia']) {
    const claimer = ['p_sam', 'p_robin', 'p_alex'].find((x) => x !== p)!;
    await ok(s.person(claimer).send('PUT', `/api/wishes/w_${p.slice(2)}_xmas/claim`, { quantity: 1 }));
  }
  await ok(g.send('PUT', `/api/guest/wishes/w_${target.slice(2)}_xmas/claim`, { quantity: 1 }));
  // A viewer who is not the target (nor a kid): their view of every other puzzle's claims, theirs left out.
  const viewer = ['p_alex', 'p_sam', 'p_robin'].find((p) => p !== target)!;
  const claims = async () => Object.fromEntries(await Promise.all(['alex', 'sam', 'robin', 'mia'].filter((p) => `p_${p}` !== viewer).map(async (p) => {
    const w = (await ok(s.person(viewer).get(`/api/people/p_${p}`))).json().wishes.find((x: { id: string }) => x.id === `w_${p}_xmas`);
    return [p, w ? [w.gift.claimed, w.gift.claims.filter((c: { mine: boolean }) => !c.mine).map((c: { giver: unknown; guest: unknown }) => [c.giver, c.guest])] : null];
  })));
  return { db, s, g, made, target, claims };
}

describe('M1 (probe P5): a draw guest\'s claim stays, unnamed, while the draw or its veil covers it', () => {
  it.each(['revoke', 'move', 'redraw'] as const)('after a %s, no wish\'s claims change for a household giver', async (variant) => {
    for (let i = 0; i < 3; i++) { // the draw is random: every receiver the cousin may get
      const x = await drawnWithCousin();
      const before = await x.claims();
      for (const v of Object.values(before)) for (const c of (v as [number, unknown[][]])[1]) expect(c).toEqual([null, null]);
      if (variant === 'revoke') await ok(x.s.person('p_alex').send('DELETE', `/api/links/${x.made.link.id}`));
      if (variant === 'move') {
        const other = x.target === 'p_mia' ? 'c_mia' : 'c_cousins';
        await ok(x.s.person(x.target === 'p_mia' ? 'p_sam' : x.target).send('PATCH', `/api/wishes/w_${x.target.slice(2)}_xmas`, { celebrationId: other }));
      }
      if (variant === 'redraw') await ok(x.s.person('p_alex').send('PATCH', '/api/celebrations/c_xmas/draw', { budgetMinor: 2000, kidsDraw: true, notLastYear: false, exclusions: [['p_alex', 'p_sam']] }));
      const after = await x.claims();
      // A moved wish leaves Christmas but not the person's page: its claims are compared all the same.
      expect(after, `${variant}: the cousin drew ${x.target}`).toEqual(before);
      expect(x.db.select().from(t.claim).all().filter((c) => c.wishId === `w_${x.target.slice(2)}_xmas`)).toHaveLength(2);
    }
  });

  it('once the draw is revealed, the first change after it settles a revoked guest\'s only-made claim', async () => {
    const x = await drawnWithCousin();
    await ok(x.s.person('p_alex').send('DELETE', `/api/links/${x.made.link.id}`));
    const onTarget = () => x.db.select().from(t.claim).all().filter((c) => c.wishId === `w_${x.target.slice(2)}_xmas`).length;
    expect(onTarget()).toBe(2);
    x.db.update(t.draw).set({ revealedAt: '2026-12-27T10:00:00.000Z' }).run();
    await ok(x.s.person('p_alex').send('PATCH', '/api/wishes/w_alex_xmas', { note: 'Any' }));
    expect(onTarget()).toBe(1);
  });

  it('after a re-draw, the cousin\'s old claim stays nobody\'s until Christmas has passed, then goes at the morning rollover, with a draw revealed never (Gate re-attack R4)', async () => {
    for (let i = 0; i < 20; i++) {
      const x = await drawnWithCousin();
      expect(x.db.select().from(t.draw).get()!.revealOn).toBeNull();
      await ok(x.s.person('p_alex').send('PATCH', '/api/celebrations/c_xmas/draw', { budgetMinor: 2000, kidsDraw: true, notLastYear: false, exclusions: [['p_alex', 'p_sam']] }));
      if ((await ok(x.g.send('POST', '/api/guest/draw/open'))).json().person.id === x.target) continue;
      const old = () => x.db.select().from(t.claim).all().filter((c) => c.wishId === `w_${x.target.slice(2)}_xmas` && c.guestId !== null).length;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-12-24T09:00:00.000Z'));
      x.s.built.morning(new Date());
      await ok(x.s.person('p_alex').send('PATCH', '/api/wishes/w_alex_xmas', { note: 'Any' }));
      expect(old()).toBe(1);
      vi.setSystemTime(new Date('2026-12-26T09:00:00.000Z'));
      x.s.built.morning(new Date());
      expect(old()).toBe(0);
      return;
    }
    throw new Error('the re-draw never gave the cousin someone else');
  });

  it('a kid\'s edit of a listed wish sends it back to a parent: the cousin\'s reservation is kept, there when the parent says yes', async () => {
    for (let i = 0; i < 40; i++) {
      const x = await drawnWithCousin();
      if (x.target !== 'p_mia') continue;
      await ok(x.s.person('p_mia').send('PATCH', '/api/wishes/w_mia_xmas', { note: 'The 1000-piece one' }));
      expect(x.db.select().from(t.wish).all().find((w) => w.id === 'w_mia_xmas')!.state).toBe('awaiting_parent');
      await ok(x.s.person('p_sam').send('POST', '/api/wishes/w_mia_xmas/approve'));
      expect(x.db.select().from(t.claim).all().filter((c) => c.wishId === 'w_mia_xmas').map((c) => Boolean(c.guestId)).sort()).toEqual([false, true]);
      return;
    }
    throw new Error('the cousin never drew Mia');
  });
});
