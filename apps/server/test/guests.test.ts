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
  const exchange = (url: string, as?: string) => inject({ method: 'POST', url: '/api/guest/session', payload: { token: url.split('#')[1] }, headers: { origin: ORIGIN, ...(as ? { cookie: sessionCookie(db, as) } : {}) } });
  const guest = (cookie: string) => ({
    get: (url: string) => inject({ url, headers: { cookie } }),
    send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => inject({ method, url, payload, headers: { cookie, origin: ORIGIN } }),
  });
  return { inject, person, exchange, guest };
}
const cookieOf = (r: { headers: Record<string, unknown> }) => String([r.headers['set-cookie']].flat()[0]).split(';')[0]!;
/** A profile row with fixed dates, different per `tag`, so two households (or a before and after) differ only in it. */
const PEOPLE_IDS = ['p_alex', 'p_sam', 'p_robin', 'p_mia', 'p_leo', 'p_quinn', 'p_uma'];
const setProfile = (db: Db, personId: string, tag: string) => {
  const row = { personId, sizesJson: JSON.stringify([{ label: 'Shoes', value: `${tag}-38` }]), sizesUpdatedAt: '2026-10-01T10:00:00.000Z',
    likesJson: JSON.stringify([`${tag} kites`]), likesUpdatedAt: '2026-10-02T10:00:00.000Z', pleaseNoJson: JSON.stringify([`${tag} glitter`]), pleaseNoUpdatedAt: '2026-10-03T10:00:00.000Z' };
  db.insert(t.profile).values(row).onConflictDoUpdate({ target: t.profile.personId, set: row }).run();
};

describe('share links', () => {
  it('the token is exchanged once by a POST for a short session; only hashes are kept', async () => {
    const db = household();
    const s = await start(db);
    const made = await s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' });
    expect(made.statusCode, made.body).toBe(201);
    const { url, link } = made.json();
    expect(url).toMatch(/^http:\/\/localhost:8080\/guest#[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ kind: 'share', label: 'Godmother', person: { id: 'p_robin', name: 'Robin' }, revokedAt: null });
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
    // The maker's list never carries the url again; the person's lists no link for them at all.
    expect((await s.person('p_alex').get('/api/links')).json().links.map((l: { id: string }) => l.id)).toEqual([link.id]);
    expect((await s.person('p_alex').get('/api/links')).body).not.toContain(token);
    expect((await s.person('p_robin').get('/api/links')).json().links).toEqual([]);
  });

  it('another grown-up makes a share link (a kid\'s: a parent), never the person; its list is the maker\'s and admins\'', async () => {
    const db = household();
    const s = await start(db);
    const make = (by: string, personId: string) => s.person(by).send('POST', `/api/people/${personId}/links`, { label: 'Granny' });
    for (const [by, p, error] of [
      ['p_robin', 'p_robin', 'another grown-up shares someone\'s wishes, never they themselves'],
      ['p_alex', 'p_alex', 'another grown-up shares someone\'s wishes, never they themselves'],
      ['p_mia', 'p_mia', 'a kid\'s parent shares their wishes'],
      ['p_mia', 'p_robin', 'another grown-up shares someone\'s wishes, never they themselves'],
      ['p_robin', 'p_mia', 'a kid\'s parent shares their wishes'],
      // Mia has a parent set (Sam): an admin is not hers.
      ['p_alex', 'p_mia', 'a kid\'s parent shares their wishes'],
    ] as const) expect([by, p, (await make(by, p)).json().error]).toEqual([by, p, error]);
    const mia = (await make('p_sam', 'p_mia')).json();
    const robin = (await make('p_sam', 'p_robin')).json();
    // Leo has no parent set: the admins are his.
    expect((await make('p_alex', 'p_leo')).statusCode).toBe(201);
    const ids = async (who: string) => (await s.person(who).get('/api/links')).json().links.map((l: { label: string; person: { id: string } }) => l.person.id).sort();
    expect(await ids('p_sam')).toEqual(['p_mia', 'p_robin']);
    expect(await ids('p_alex')).toEqual(['p_leo', 'p_mia', 'p_robin']);
    expect(await ids('p_robin')).toEqual([]);
    expect(await ids('p_mia')).toEqual([]);
    expect(await ids('p_leo')).toEqual([]);
    // Only its maker and admins revoke it (the person never: a 404, as for none).
    expect((await s.person('p_robin').send('DELETE', `/api/links/${robin.link.id}`)).statusCode).toBe(404);
    expect((await s.person('p_mia').send('DELETE', `/api/links/${mia.link.id}`)).statusCode).toBe(404);
    expect((await s.person('p_alex').send('DELETE', `/api/links/${robin.link.id}`)).statusCode).toBe(204);
    expect((await s.person('p_sam').get('/api/links')).json().links.find((l: { id: string }) => l.id === robin.link.id).revokedAt).not.toBeNull();
  });

  it('one answer for every failure: unknown, revoked, and a browser whose household session the link is not for', async () => {
    const db = withDraws(household());
    const s = await start(db);
    const bad = await s.exchange('x#' + 'z'.repeat(43));
    expect([bad.statusCode, bad.json()]).toEqual([401, { error: 'this link is unknown, used or expired' }]);
    const robin = (await s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' })).json();
    const mia = (await s.person('p_sam').send('POST', '/api/people/p_mia/links', { label: 'Granny' })).json();
    const cousin = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    // The person, a kid, and (a draw link) anyone in that draw: the one answer, no session made.
    for (const [url, who] of [[robin.url, 'p_robin'], [robin.url, 'p_mia'], [robin.url, 'p_leo'], [mia.url, 'p_mia'], [mia.url, 'p_leo'],
      [cousin.url, 'p_alex'], [cousin.url, 'p_sam'], [cousin.url, 'p_robin'], [cousin.url, 'p_mia']] as const) {
      const r = await s.exchange(url, who);
      expect([who, r.statusCode, r.json(), r.headers['set-cookie']]).toEqual([who, 401, bad.json(), undefined]);
    }
    expect(db.select().from(t.guestSession).all()).toEqual([]);
    // Someone giving to them may (testing the link they made, say); someone not in the draw may.
    expect((await s.exchange(robin.url, 'p_sam')).statusCode).toBe(200);
    expect((await s.exchange(mia.url, 'p_robin')).statusCode).toBe(200);
    expect((await s.exchange(cousin.url, 'p_leo')).statusCode).toBe(401);
    const g = await s.exchange(mia.url);
    expect(g.statusCode).toBe(200);
    // Revoked: the session ends at once, the link opens nothing.
    expect((await s.person('p_sam').send('DELETE', `/api/links/${mia.link.id}`)).statusCode).toBe(204);
    expect((await s.guest(cookieOf(g)).get('/api/guest')).statusCode).toBe(401);
    expect((await s.exchange(mia.url)).json()).toEqual(bad.json());
    const other = await s.inject({ method: 'POST', url: '/api/guest/session', payload: { token: 'z'.repeat(43) }, headers: { origin: 'https://evil.example' } });
    expect(other.statusCode).toBe(403);
  });

  it.each([
    { who: 'robin' as const, links: ['gR', 'gR2'] },
    { who: 'mia' as const, links: ['gM'] },
  ])('$who can never hold a working link to their own wishes: every answer is byte for byte that of a household with none', async ({ who, links }) => {
    const [a, none] = [await home(), await home()];
    // In one twin: their links, a fresh one made by another grown-up, a guest's claim on their wish; in the other none.
    const personId = `p_${who}`;
    const maker = who === 'mia' ? 'sam' : 'alex';
    const made = (await ok(as(a, maker).send('POST', `/api/people/${personId}/links`, { label: 'Neighbours' }))).json();
    const wish = who === 'mia' ? 'w_mia_bike' : (await ok(as(a, 'robin').send('POST', '/api/wishes', { personId, name: 'A lantern', celebrationId: null }))).json().id;
    if (who === 'robin') {
      await ok(as(none, 'robin').send('POST', '/api/wishes', { personId, name: 'A lantern', celebrationId: null }));
      const w = a.db.select().from(t.wish).where(eq(t.wish.id, wish)).get()!;
      none.db.update(t.wish).set({ id: w.id, createdAt: w.createdAt, updatedAt: w.updatedAt }).where(eq(t.wish.name, 'A lantern')).run();
    }
    await ok(as(a, links[0] as 'gR' | 'gM').send('PUT', `/api/guest/wishes/${wish}/claim`, { quantity: 1 }));
    none.db.delete(t.guestLink).where(eq(t.guestLink.personId, personId)).run();
    // A link they would make themselves: refused (and the same in both).
    for (const h of [a, none]) expect((await as(h, who).send('POST', `/api/people/${personId}/links`, { label: 'Me' })).statusCode).toBe(403);
    const [x, y] = [await reads(a, who), await reads(none, who)];
    for (const k of Object.keys(x)) expect(x[k], k).toBe(y[k]);
    // No answer of theirs carries an address or a token; and the one made for them does not open in their browser.
    expect(JSON.stringify(x)).not.toContain('/guest#');
    expect(JSON.stringify(x)).not.toContain(made.url.split('#')[1]);
    const r = await a.built.app.inject({ method: 'POST', url: '/api/guest/session', payload: { token: made.url.split('#')[1] }, headers: { origin: ORIGIN, cookie: a.cookies[who]! } });
    expect(r.statusCode).toBe(401);
  }, 60_000);

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
    expect(page.wishes.find((w: { id: string }) => w.id === kite).gift.claims).toEqual([{ giver: null, guest: null, imported: false, quantity: 1, state: 'claimed', mine: false }]);
    const body = JSON.stringify(page);
    for (const leak of ['Quinn', 'p_quinn', 'Alex', 'p_alex', 'ideas']) expect(body, leak).not.toContain(leak);
    expect((await as(h, 'gR').send('PUT', '/api/guest/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(404);
    expect((await as(h, 'gR').send('PUT', '/api/guest/wishes/w_mia_bike/claim', { quantity: 1 })).statusCode).toBe(404);
    h.db.update(t.guestLink).set({ guestName: null }).where(eq(t.guestLink.id, 'l_gR')).run();
    expect((await as(h, 'gR').send('PUT', `/api/guest/wishes/${lantern}/claim`, { quantity: 1 })).json().error).toBe('tell us your name first');
    expect((await ok(as(h, 'gR').send('PUT', '/api/guest/name', { name: 'Ada' }))).json().name).toBe('Ada');
    const c = await ok(as(h, 'gR').send('PUT', `/api/guest/wishes/${lantern}/claim`, { quantity: 1 }));
    expect(c.json().gift.claims).toEqual([{ giver: null, guest: null, imported: false, quantity: 1, state: 'claimed', mine: true }]);
    expect((await as(h, 'gR2').get('/api/guest')).json().wishes.find((w: { id: string }) => w.id === lantern).gift.claims).toEqual([{ giver: null, guest: null, imported: false, quantity: 1, state: 'claimed', mine: false }]);
    // The household's givers see the guest's name; Robin and the kids nothing.
    expect((await as(h, 'alex').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === lantern).gift.claims[0]).toMatchObject({ giver: null, guest: { name: 'Ada', label: 'Guest gR' } });
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
  it('a share guest sees their person\'s sizes, likes and "please no", read-only', async () => {
    const h = await home();
    await ok(as(h, 'robin').send('PUT', '/api/people/p_robin/profile', { sizes: [{ label: 'Jumper', value: 'M' }], likes: ['Kites'], pleaseNo: ['Glitter'] }));
    await ok(as(h, 'sam').send('PUT', '/api/people/p_mia/profile', { sizes: [{ label: 'Shoes', value: '31' }] }));
    expect((await as(h, 'gR').get('/api/guest')).json().profile).toMatchObject({ sizes: [{ label: 'Jumper', value: 'M' }], likes: ['Kites'], pleaseNo: ['Glitter'] });
    expect((await as(h, 'gM').get('/api/guest')).json().profile).toMatchObject({ sizes: [{ label: 'Shoes', value: '31' }], likes: [], pleaseNo: [] });
    // Read-only: a guest's session opens no profile route, its own or the household's.
    for (const u of ['/api/people/p_robin/profile', '/api/guest/profile']) expect([401, 404], u).toContain((await as(h, 'gR').send('PUT', u, { likes: ['x'] })).statusCode);
    expect(h.db.select().from(t.profile).all().flatMap((r) => JSON.parse(r.likesJson))).toEqual(['Kites']);
  });

  it.each([
    { guest: 'gR' as const, person: 'p_robin' },
    { guest: 'gR2' as const, person: 'p_robin' },
    { guest: 'gM' as const, person: 'p_mia' },
  ])('$guest gets the same answers whatever anyone but their person keeps as a profile', async ({ guest, person }) => {
    const [a, b] = [await home(), await home()];
    setProfile(a.db, person, 'same'); setProfile(b.db, person, 'same');
    for (const p of PEOPLE_IDS.filter((x) => x !== person)) setProfile(a.db, p, `a-${p}`);
    const [x, y] = [await reads(a, guest), await reads(b, guest)];
    for (const k of Object.keys(x)) expect(x[k], k).toBe(y[k]);
    expect(x['/api/guest']).toContain('same kites');
  });
});

describe('a guest session left in a shared browser (review N1)', () => {
  /** A guest route's answer with these cookies along: status, body and headers but `date`. */
  const answer = async (h: Home, cookie: string, method: 'GET' | 'POST' = 'GET', url = '/api/guest', payload?: object) => {
    const r = await h.built.app.inject({ method, url, payload, headers: { cookie, origin: ORIGIN } });
    return JSON.stringify([r.statusCode, r.body, Object.entries(r.headers).filter(([k]) => k !== 'date').sort()]);
  };
  const UNKNOWN_GUEST = `keepsake_guest=${'u'.repeat(43)}`;

  it.each([
    { who: 'robin' as const, guest: 'gR' as const },
    { who: 'mia' as const, guest: 'gM' as const },
    { who: 'mia' as const, guest: 'gR' as const },
    { who: 'leo' as const, guest: 'gM' as const },
  ])('$guest\'s session with $who signed in answers exactly like an unknown one, and ends', async ({ who, guest }) => {
    const h = await home();
    const both = `${h.cookies[guest]}; ${h.cookies[who]}`;
    const unknown = `${UNKNOWN_GUEST}; ${h.cookies[who]}`;
    for (const [m, u, b] of [['GET', '/api/guest'], ['POST', '/api/guest/questions', { text: 'Which colour?' }]] as const) {
      expect(await answer(h, both, m, u, b), u).toBe(await answer(h, unknown, m, u, b));
    }
    expect(await answer(h, both)).toContain('keepsake_guest=;');
    expect(h.db.select().from(t.question).all()).toEqual([]);
    // The session is gone: without the household session along it opens nothing either.
    expect((await as(h, guest).get('/api/guest')).statusCode).toBe(401);
    expect(h.db.select().from(t.guestSession).where(eq(t.guestSession.linkId, `l_${guest}`)).all()).toEqual([]);
  });

  it('with someone signed in who may see it (giving to its person), the guest session goes on', async () => {
    const h = await home();
    for (const [who, guest] of [['sam', 'gR'], ['robin', 'gM'], ['alex', 'gM']] as const) {
      const r = await h.built.app.inject({ url: '/api/guest', headers: { cookie: `${h.cookies[guest]}; ${h.cookies[who]}` } });
      expect([who, guest, r.statusCode, r.headers['set-cookie']]).toEqual([who, guest, 200, undefined]);
    }
  });

  it('a draw guest\'s session with someone of that draw signed in: refused like an unknown one', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    db.insert(t.person).values({ id: 'p_quinn', name: 'Quinn', role: 'adult', createdAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    const g = cookieOf(await s.exchange(made.url));
    // A grown-up outside the draw: the session goes on.
    const quinn = await s.inject({ url: '/api/guest', headers: { cookie: `${g}; ${sessionCookie(db, 'p_quinn')}` } });
    expect(quinn.statusCode).toBe(200);
    const sam = await s.inject({ url: '/api/guest', headers: { cookie: `${g}; ${sessionCookie(db, 'p_sam')}` } });
    const unknown = await s.inject({ url: '/api/guest', headers: { cookie: `keepsake_guest=${'u'.repeat(43)}; ${sessionCookie(db, 'p_sam')}` } });
    expect([sam.statusCode, sam.body, sam.headers['set-cookie']]).toEqual([unknown.statusCode, unknown.body, unknown.headers['set-cookie']]);
    expect((await s.guest(g).get('/api/guest')).statusCode).toBe(401);
  });
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

describe('a guest\'s claims once they cannot manage them (review M1)', () => {
  it('revoking a link: only-made claims go, bought ones stay with nobody\'s name; the person and kids learn nothing', async () => {
    const [a, none] = [await home(), await home()];
    for (const h of [a, none]) for (const name of ['A lantern', 'A kite']) await ok(as(h, 'robin').send('POST', '/api/wishes', { personId: 'p_robin', name, celebrationId: null }));
    for (const name of ['A lantern', 'A kite']) {
      const w = a.db.select().from(t.wish).where(eq(t.wish.name, name)).get()!;
      none.db.update(t.wish).set({ id: w.id, createdAt: w.createdAt, updatedAt: w.updatedAt }).where(eq(t.wish.name, name)).run();
    }
    const id = (name: string) => a.db.select().from(t.wish).where(eq(t.wish.name, name)).get()!.id;
    await ok(as(a, 'gR').send('PUT', `/api/guest/wishes/${id('A lantern')}/claim`, { quantity: 1 }));
    await ok(as(a, 'gR2').send('PUT', `/api/guest/wishes/${id('A kite')}/claim`, { quantity: 1 }));
    await ok(as(a, 'gR2').send('PATCH', `/api/guest/wishes/${id('A kite')}/claim`, { state: 'bought' }));
    for (const h of [a, none]) for (const l of ['l_gR', 'l_gR2']) expect((await as(h, 'alex').send('DELETE', `/api/links/${l}`)).statusCode).toBe(204);
    expect(a.db.select().from(t.claim).all().filter((c) => [id('A lantern'), id('A kite')].includes(c.wishId)).map((c) => [c.wishId === id('A kite'), c.state, c.guestId, c.giverId]))
      .toEqual([[true, 'bought', null, null]]);
    // The lantern is free again for the household; the kite shows as bought by nobody named.
    await ok(as(a, 'sam').send('PUT', `/api/wishes/${id('A lantern')}/claim`, { quantity: 1 }));
    await ok(as(none, 'sam').send('PUT', `/api/wishes/${id('A lantern')}/claim`, { quantity: 1 }));
    expect((await as(a, 'alex').get('/api/people/p_robin')).json().wishes.find((w: { id: string }) => w.id === id('A kite')).gift.claims)
      .toEqual([{ giver: null, guest: null, imported: false, quantity: 1, state: 'bought', mine: false }]);
    for (const v of ['robin', 'mia', 'leo'] as const) {
      const [x, y] = [await reads(a, v), await reads(none, v)];
      for (const k of Object.keys(x)) expect(x[k], `${v} ${k}`).toBe(y[k]);
    }
  }, 60_000);

  it('a re-draw that gives a draw guest someone else, and removing their celebration, take their only-made claims', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    for (const p of ['alex', 'sam', 'robin', 'mia']) db.insert(t.wish).values({ id: `w_${p}_xmas`, personId: `p_${p}`, celebrationId: 'c_xmas', name: 'A puzzle', state: 'listed', position: 9, addedBy: `p_${p}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const g = s.guest(cookieOf(await s.exchange(made.url)));
    const first = (await ok(g.send('POST', '/api/guest/draw/open'))).json().person.id as string;
    await ok(g.send('PUT', `/api/guest/wishes/w_${first.slice(2)}_xmas/claim`, { quantity: 1 }));
    const guestClaims = () => db.select().from(t.claim).all().filter((c) => c.guestId === made.link.id || (c.giverId === null && c.wishId.endsWith('_xmas')));
    expect(guestClaims()).toHaveLength(1);
    // Drawn again until the guest has someone else: their claim on the first person's wish goes with it.
    let now = first;
    for (let i = 0; i < 15 && now === first; i++) {
      await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
      if (guestClaims().length === 0) { now = 'changed'; break; }
    }
    expect(now).toBe('changed');
    // With their new person: a claim, then the celebration goes, and the claim with it (not left with no giver).
    const second = (await ok(g.send('POST', '/api/guest/draw/open'))).json().person.id as string;
    await ok(g.send('PUT', `/api/guest/wishes/w_${second.slice(2)}_xmas/claim`, { quantity: 1 }));
    expect(guestClaims()).toHaveLength(1);
    expect((await s.person('p_alex').send('DELETE', '/api/celebrations/c_xmas')).statusCode).toBe(204);
    expect(db.select().from(t.claim).all().filter((c) => c.giverId === null && c.imported === 0)).toEqual([]);
  });
});

describe('guests\' names (review M2)', () => {
  it('never a household member\'s, case and accents aside, and no control characters; claims show the guest as one', async () => {
    const h = await home();
    for (const name of ['Robin', 'robin', ' ROBIN ', 'Róbin', 'Alex']) expect((await as(h, 'gR').send('PUT', '/api/guest/name', { name })).json().error, name).toBe('someone in the household has that name: add something to tell them apart');
    for (const name of ['Ada\u202Emiss', 'Ada\u0007']) expect((await as(h, 'gR').send('PUT', '/api/guest/name', { name })).json().error).toBe('name: 1 to 60 characters, without control characters');
    expect((await as(h, 'alex').send('POST', '/api/people/p_robin/links', { label: 'Gran\u2066ny' })).json().error).toBe('label: 1 to 60 characters, without control characters');
    expect((await ok(as(h, 'gR').send('PUT', '/api/guest/name', { name: 'Robin from next door' }))).json().name).toBe('Robin from next door');
    const db = withDraws(household());
    const s = await start(db);
    expect((await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'sam' })).json().error).toBe('someone in the household has that name: add something to tell them apart');
    expect(db.select().from(t.guestLink).all()).toEqual([]);
  });
});

describe('a draw guest\'s profiles', () => {
  it('none before their draw is opened, then their own person\'s only: nobody else\'s changes a byte', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    const g = s.guest(cookieOf(await s.exchange(made.url)));
    const before = (await ok(g.get('/api/guest'))).body;
    expect(JSON.parse(before).profile).toBeNull();
    const ids = db.select().from(t.person).all().map((p) => p.id);
    for (const p of ids) setProfile(db, p, `x-${p}`);
    expect((await ok(g.get('/api/guest'))).body).toBe(before);
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const opened = (await ok(g.send('POST', '/api/guest/draw/open'))).json();
    const mine = opened.person.id as string;
    expect(opened.profile).toMatchObject({ likes: [`x-${mine} kites`] });
    const after = (await ok(g.get('/api/guest'))).body;
    for (const p of ids.filter((x) => x !== mine)) setProfile(db, p, `y-${p}`);
    expect((await ok(g.get('/api/guest'))).body).toBe(after);
    for (const p of ids.filter((x) => x !== mine)) expect(after, p).not.toContain(`x-${p} `);
  });
});

it('tokens look like every other token', () => expect(tokenOf('gR')).toHaveLength(43));
