// Guests by link (ADR 0009): the token lives in the link's #fragment and is exchanged once by a POST for a short
// session; tokens are hashed at rest; revoking ends the session at once; a kid's own link waits for a parent; a guest
// reaches one person (or one draw and their own person's list for it), claims, asks and names themselves, nothing else;
// a draw link joins the draw under its rules and ends with the draw's day. The person never learns a guest's claim.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { hashToken } from '../src/auth/tokens';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, household, inDays, sessionCookie, standalone, withDraws } from './helpers';
import { as, makeHome, ok, reads, tokenOf, type Home } from './m4';

const apps: BuiltApp[] = [];
const homes: Home[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.app.close(); for (const h of homes.splice(0)) await h.built.app.close(); });
const home = async () => { const h = await makeHome(); homes.push(h); return h; };

async function start(db: Db) {
  const built = await buildApp(standalone(), db);
  apps.push(built);
  const inject = built.app.inject.bind(built.app);
  const person = (id: string) => ({
    get: (url: string) => inject({ url, headers: { cookie: sessionCookie(db, id) } }),
    send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => inject({ method, url, payload, headers: { cookie: sessionCookie(db, id), origin: ORIGIN } }),
  });
  /** Opens a link the way the guest page does: the fragment's token in a POST body. Returns the guest's cookie. */
  const exchange = (url: string) => inject({ method: 'POST', url: '/api/guest/session', payload: { token: url.split('#')[1] }, headers: { origin: ORIGIN } });
  const guest = (cookie: string) => ({
    get: (url: string) => inject({ url, headers: { cookie } }),
    send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => inject({ method, url, payload, headers: { cookie, origin: ORIGIN } }),
  });
  return { inject, person, exchange, guest };
}
const cookieOf = (r: { headers: Record<string, unknown> }) => String([r.headers['set-cookie']].flat()[0]).split(';')[0]!;

describe('share links', () => {
  it('the token is exchanged once by a POST for a short session; only hashes are kept', async () => {
    const db = household();
    const s = await start(db);
    const made = await s.person('p_robin').send('POST', '/api/people/p_robin/links', { label: 'Godmother' });
    expect(made.statusCode, made.body).toBe(201);
    const { url, link } = made.json();
    expect(url).toMatch(/^http:\/\/localhost:8080\/guest#[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ kind: 'share', label: 'Godmother', person: { id: 'p_robin', name: 'Robin' }, approved: true });
    const token = url.split('#')[1];
    const r = await s.exchange(url);
    expect(r.statusCode, r.body).toBe(200);
    const set = String([r.headers['set-cookie']].flat()[0]);
    expect(set).toMatch(/^keepsake_guest=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    expect(r.json()).toMatchObject({ kind: 'share', name: null, person: { id: 'p_robin', name: 'Robin' }, celebration: null, draw: null });
    // Neither token is in the database, only their SHA-256.
    const dump = JSON.stringify([db.select().from(t.guestLink).all(), db.select().from(t.guestSession).all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(cookieOf(r).split('=')[1]);
    expect(dump).toContain(hashToken(token));
    // The link list never carries the url again.
    expect((await s.person('p_robin').get('/api/links')).body).not.toContain(token);
  });

  it('one answer for every failure: unknown, revoked, a kid\'s waiting for a parent; another origin is refused', async () => {
    const db = household();
    const s = await start(db);
    const bad = await s.exchange('x#' + 'z'.repeat(43));
    expect([bad.statusCode, bad.json()]).toEqual([401, { error: 'this link is unknown, used or expired' }]);
    const kid = (await s.person('p_mia').send('POST', '/api/people/p_mia/links', { label: 'Granny' })).json();
    expect(kid.link.approved).toBe(false);
    expect((await s.exchange(kid.url)).json()).toEqual(bad.json());
    expect((await s.person('p_robin').send('POST', `/api/links/${kid.link.id}/approve`)).statusCode).toBe(404);
    expect((await s.person('p_mia').send('POST', `/api/links/${kid.link.id}/approve`)).statusCode).toBe(403);
    expect((await s.person('p_sam').get('/api/links')).json().links.map((l: { id: string; canApprove: boolean }) => [l.id, l.canApprove])).toEqual([[kid.link.id, true]]);
    expect((await s.person('p_sam').send('POST', `/api/links/${kid.link.id}/approve`)).json().approved).toBe(true);
    const g = await s.exchange(kid.url);
    expect(g.statusCode).toBe(200);
    // Revoked: the session ends at once, the link opens nothing.
    expect((await s.person('p_sam').send('DELETE', `/api/links/${kid.link.id}`)).statusCode).toBe(204);
    expect((await s.guest(cookieOf(g)).get('/api/guest')).statusCode).toBe(401);
    expect((await s.exchange(kid.url)).json()).toEqual(bad.json());
    const other = await s.inject({ method: 'POST', url: '/api/guest/session', payload: { token: 'z'.repeat(43) }, headers: { origin: 'https://evil.example' } });
    expect(other.statusCode).toBe(403);
    // Someone who does not keep the list makes no link for it.
    expect((await s.person('p_robin').send('POST', '/api/people/p_sam/links', { label: 'x' })).statusCode).toBe(403);
  });

  it('the exchange is rate limited like a sign-in', async () => {
    const s = await start(household());
    const codes = [];
    for (let i = 0; i < 22; i++) codes.push((await s.exchange('x#' + 'z'.repeat(43))).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });

  it('a guest session opens /guest/* only, and a person\'s session opens no /guest/* route', async () => {
    const h = await home();
    for (const u of ['/api/home', '/api/household', '/api/people/p_robin', '/api/links', '/api/celebrations']) expect((await as(h, 'gR').get(u)).statusCode, u).toBe(401);
    expect((await as(h, 'gR').send('POST', '/api/people/p_robin/questions', { text: 'x?' })).statusCode).toBe(401);
    expect((await as(h, 'gR').send('PUT', '/api/wishes/w_robin_scarf/claim', { quantity: 1 })).statusCode).toBe(401);
    expect((await as(h, 'robin').get('/api/guest')).statusCode).toBe(401);
  });

  it('a guest sees one person\'s listed wishes, claims once named, and names nobody', async () => {
    const h = await home();
    const robin = await ok(as(h, 'robin').send('POST', '/api/wishes', { personId: 'p_robin', name: 'A lantern', celebrationId: null }));
    const lantern = robin.json().id;
    const kite = (await ok(as(h, 'robin').send('POST', '/api/wishes', { personId: 'p_robin', name: 'A kite', celebrationId: null }))).json().id;
    await ok(as(h, 'quinn').send('PUT', `/api/wishes/${kite}/claim`, { quantity: 1 }));
    const page = (await as(h, 'gR').get('/api/guest')).json();
    // The scarf was given last Christmas: gone for givers. Quinn's claim on the kite names nobody.
    expect(page.wishes.map((w: { id: string }) => w.id).sort()).toEqual([lantern, kite].sort());
    expect(page.wishes.find((w: { id: string }) => w.id === kite).gift.claims).toEqual([{ giver: null, guest: null, quantity: 1, state: 'claimed', mine: false }]);
    const body = JSON.stringify(page);
    for (const leak of ['Quinn', 'p_quinn', 'Alex', 'p_alex', 'ideas', 'profile']) expect(body, leak).not.toContain(leak);
    expect((await as(h, 'gR').send('PUT', '/api/guest/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(404);
    expect((await as(h, 'gR').send('PUT', '/api/guest/wishes/w_mia_bike/claim', { quantity: 1 })).statusCode).toBe(404);
    h.db.update(t.guestLink).set({ guestName: null }).where(eq(t.guestLink.id, 'l_gR')).run();
    expect((await as(h, 'gR').send('PUT', `/api/guest/wishes/${lantern}/claim`, { quantity: 1 })).json().error).toBe('tell us your name first');
    expect((await ok(as(h, 'gR').send('PUT', '/api/guest/name', { name: 'Ada' }))).json().name).toBe('Ada');
    const c = await ok(as(h, 'gR').send('PUT', `/api/guest/wishes/${lantern}/claim`, { quantity: 1 }));
    expect(c.json().gift.claims).toEqual([{ giver: null, guest: null, quantity: 1, state: 'claimed', mine: true }]);
    expect((await as(h, 'gR2').get('/api/guest')).json().wishes.find((w: { id: string }) => w.id === lantern).gift.claims).toEqual([{ giver: null, guest: null, quantity: 1, state: 'claimed', mine: false }]);
    // The household's givers see the guest's name; Robin and the kids nothing.
    expect((await as(h, 'alex').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === lantern).gift.claims[0]).toMatchObject({ giver: null, guest: 'Ada' });
    await ok(as(h, 'gR').send('PATCH', `/api/guest/wishes/${lantern}/claim`, { state: 'bought' }));
    expect((await as(h, 'gR').send('DELETE', `/api/guest/wishes/${lantern}/claim`)).statusCode).toBe(204);
  });

  it.each([
    { title: 'a guest\'s claim and question for Robin', viewers: ['robin', 'mia', 'leo'] as const, kid: false },
    { title: 'a guest\'s claim on Mia\'s wish', viewers: ['mia', 'leo'] as const, kid: true },
  ])('the person and kids get the same answers with or without $title', async ({ viewers, kid }) => {
    const [a, none] = [await home(), await home()];
    for (const h of [a, none]) await ok(as(h, 'robin').send('POST', '/api/wishes', { personId: 'p_robin', name: 'A lantern', celebrationId: null }));
    // Same ids in both, made at different moments: align them.
    const id = a.db.select().from(t.wish).where(eq(t.wish.name, 'A lantern')).get()!;
    none.db.update(t.wish).set({ id: id.id, createdAt: id.createdAt, updatedAt: id.updatedAt }).where(eq(t.wish.name, 'A lantern')).run();
    if (kid) await ok(as(a, 'gM').send('PUT', '/api/guest/wishes/w_mia_bike/claim', { quantity: 1 }));
    else {
      await ok(as(a, 'gR').send('PUT', `/api/guest/wishes/${id.id}/claim`, { quantity: 1 }));
      await ok(as(a, 'gR').send('POST', '/api/guest/questions', { text: 'Which colour?' }));
    }
    for (const v of viewers) {
      const [x, y] = [await reads(a, v), await reads(none, v)];
      for (const k of Object.keys(x)) expect(x[k], `${v} ${k}`).toBe(y[k]);
    }
  }, 30_000);
});

describe('personal draw links', () => {
  /** withDraws: Christmas's draw (Alex hosts; Alex, Sam, Robin, Mia). */
  const fresh = () => { const db = withDraws(household()); db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run(); return db; };

  it('the host invites a guest: they join the draw, under its rules, see their own person\'s list for it, and the link ends with its day', async () => {
    const db = fresh();
    const s = await start(db);
    expect((await s.person('p_sam').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).statusCode).toBe(403);
    const made = await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().link).toMatchObject({ kind: 'draw', label: 'Cousin Ada', celebration: { id: 'c_xmas', name: 'Christmas' } });
    const draw = (await s.person('p_alex').get('/api/celebrations/c_xmas/draw')).json();
    expect([draw.total, draw.guests]).toEqual([5, ['Cousin Ada']]);
    const g = s.guest(cookieOf(await s.exchange(made.json().url)));
    const before = (await g.get('/api/guest')).json();
    expect(before).toMatchObject({ kind: 'draw', name: 'Cousin Ada', person: null, wishes: [], draw: { drawn: false, opened: false, total: 5 } });
    expect((await g.send('POST', '/api/guest/draw/open')).statusCode).toBe(409);
    expect((await g.send('POST', '/api/guest/questions', { text: 'x?' })).json().error).toBe('open your draw first: then you can ask your person');
    expect((await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run')).statusCode).toBe(200);
    const opened = (await ok(g.send('POST', '/api/guest/draw/open'))).json();
    expect(opened.draw).toMatchObject({ drawn: true, opened: true, openedCount: 1 });
    // Their person is one of the four (a guest never draws themselves); their list for Christmas, nothing else.
    expect(['p_alex', 'p_sam', 'p_robin', 'p_mia']).toContain(opened.person.id);
    const theirs = db.select().from(t.wish).all().filter((w) => w.personId === opened.person.id && w.state === 'listed' && (w.celebrationId === null || w.celebrationId === 'c_xmas'))
      .filter((w) => !db.select().from(t.claim).where(eq(t.claim.wishId, w.id)).all().some((c) => c.state === 'given')).map((w) => w.id).sort();
    expect(opened.wishes.map((w: { id: string }) => w.id).sort()).toEqual(theirs);
    // Whoever drew the guest sees a guest, by name.
    const pairsGuest = await Promise.all(['p_alex', 'p_sam', 'p_robin', 'p_mia'].map(async (p) => {
      await s.person(p).send('POST', '/api/celebrations/c_xmas/draw/open');
      return (await s.person(p).get('/api/celebrations/c_xmas/draw')).json().mine;
    }));
    expect(pairsGuest.filter((m) => m.receiverGuest).map((m) => m.receiver.name)).toEqual(['Cousin Ada']);
    // The draw's day is the link's last day; after it the link opens nothing.
    const last = (await s.person('p_alex').get('/api/links')).json().links[0].lastDay;
    expect(last).toBe(draw.on);
    const year = db.select().from(t.draw).get()!.year;
    db.update(t.draw).set({ year: year - 1, occasionOn: inDays(-1) }).where(eq(t.draw.id, 'd_xmas')).run();
    db.update(t.celebration).set({ date: inDays(-1), recurrence: 'none' }).where(eq(t.celebration.id, 'c_xmas')).run();
    expect((await g.get('/api/guest')).statusCode).toBe(401);
    expect((await s.exchange(made.json().url)).statusCode).toBe(401);
  });

  it('guests count toward the draw\'s rules: three people and a guest may draw; inviting after the draw draws again', async () => {
    const db = fresh();
    const s = await start(db);
    await s.person('p_alex').send('PATCH', '/api/celebrations/c_xmas/draw', { people: ['p_alex', 'p_sam', 'p_robin'] });
    expect((await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run')).json().error).toBe('a draw needs at least 4 people');
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' }));
    expect((await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run')).statusCode).toBe(200);
    expect(db.select().from(t.drawAssignment).all()).toHaveLength(4);
    await ok(s.person('p_sam').send('POST', '/api/celebrations/c_xmas/draw/open'));
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ben' }));
    const d = (await s.person('p_sam').get('/api/celebrations/c_xmas/draw')).json();
    expect(d).toMatchObject({ total: 5, opened: 0, guests: ['Cousin Ada', 'Cousin Ben'] });
    expect(d.redrawnAt).not.toBeNull();
    expect(db.select().from(t.drawAssignment).all()).toHaveLength(5);
    // With not last year's person on, five are needed: the guests count.
    await ok(s.person('p_alex').send('PATCH', '/api/celebrations/c_xmas/draw', { notLastYear: true }));
  });

  it('a revoked draw guest leaves a draw not drawn yet', async () => {
    const db = fresh();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    expect((await s.person('p_alex').send('DELETE', `/api/links/${made.link.id}`)).statusCode).toBe(204);
    expect((await s.person('p_alex').get('/api/celebrations/c_xmas/draw')).json()).toMatchObject({ total: 4, guests: [] });
  });

  it('while the draw is secret a draw guest\'s claim for another of its people names nobody', async () => {
    const db = fresh();
    // Whoever the guest draws has something on their Christmas list.
    for (const p of ['robin', 'mia']) db.insert(t.wish).values({ id: `w_${p}_xmas`, personId: `p_${p}`, celebrationId: 'c_xmas', name: 'A puzzle', state: 'listed', position: 9, addedBy: `p_${p}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const g = s.guest(cookieOf(await s.exchange(made.url)));
    const page = (await ok(g.send('POST', '/api/guest/draw/open'))).json();
    const wish = page.wishes[0];
    expect(wish).toBeDefined();
    await ok(g.send('PUT', `/api/guest/wishes/${wish.id}/claim`, { quantity: 1 }));
    const viewer = ['p_alex', 'p_sam', 'p_robin'].find((p) => p !== page.person.id)!;
    const c = (await s.person(viewer).get(`/api/people/${page.person.id}`)).json().wishes.find((w: { id: string }) => w.id === wish.id).gift.claims[0];
    expect(c).toMatchObject({ giver: null, guest: null, quantity: 1 });
  });
});

it('tokens look like every other token', () => expect(tokenOf('gR')).toHaveLength(43));
