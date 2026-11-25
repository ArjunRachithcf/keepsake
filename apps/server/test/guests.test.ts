// Guests by link (ADR 0009): the token lives in the link's #fragment and is exchanged by a POST for a session on one
// device (the first exchange spends it); tokens are hashed at rest; revoking ends the session at once; a share link is
// another grown-up's (a kid's: a parent's), never the person's; a guest session never opens with a household session
// it is not for; a guest reaches one person (or one draw and their own person's list for it), claims, asks and names
// themselves, nothing else; a draw link joins the draw under its rules and ends with the draw's day. The person never
// learns a guest's claim.
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { hashToken } from '../src/auth/tokens';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, household, inDays, sessionCookie, standalone, withDraws } from './helpers';
import { as, makeHome, ok, pin, reads, setNow, tokenOf, type Home } from './m4';
import { openLink } from '../src/guests/guests';

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
  const exchange = (url: string, as?: string, device?: string) => inject({ method: 'POST', url: '/api/guest/session', payload: { token: url.split('#')[1] },
    headers: { origin: ORIGIN, ...(as || device ? { cookie: [device, as && sessionCookie(db, as)].filter(Boolean).join('; ') } : {}) } });
  /** The guest of an exchange's answer, in that browser: its device cookie, and its link named on every request. */
  const guest = (r: { headers: Record<string, unknown>; json: () => { link: string } }) => {
    const headers = { cookie: cookieOf(r), 'x-keepsake-link': r.json().link };
    return {
      get: (url: string) => inject({ url, headers }),
      send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) => inject({ method, url, payload, headers: { ...headers, origin: ORIGIN } }),
    };
  };
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
  it('the token is exchanged once by a POST for a session; only hashes are kept', async () => {
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
    expect(set).toMatch(/^keepsake_guest=[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
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

  it('a kid\'s share links follow the kid\'s current parents (review L-c)', async () => {
    const db = household();
    const s = await start(db);
    const made = (await ok(s.person('p_sam').send('POST', '/api/people/p_mia/links', { label: 'Granny' }))).json();
    const listed = async (who: string) => (await s.person(who).get('/api/links')).json().links.map((l: { id: string }) => l.id);
    expect([await listed('p_sam'), await listed('p_robin')]).toEqual([[made.link.id], []]);
    // An admin makes Robin Mia's parent instead of Sam: the link goes with Mia.
    await ok(s.person('p_alex').send('PUT', '/api/people/p_mia/managers', { managerIds: ['p_robin'] }));
    expect([await listed('p_sam'), await listed('p_robin'), await listed('p_alex'), await listed('p_mia')]).toEqual([[], [made.link.id], [made.link.id], []]);
    expect((await s.person('p_sam').send('DELETE', `/api/links/${made.link.id}`)).statusCode).toBe(404);
    expect((await s.person('p_robin').send('DELETE', `/api/links/${made.link.id}`)).statusCode).toBe(204);
    // A grown-up's share link stays its maker's (and admins').
    const robin = (await ok(s.person('p_sam').send('POST', '/api/people/p_robin/links', { label: 'Neighbours' }))).json();
    expect([await listed('p_sam'), (await listed('p_robin')).includes(robin.link.id)]).toEqual([[robin.link.id], false]);
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
    const g = await s.exchange(mia.url, 'p_robin');
    expect(g.statusCode).toBe(200);
    expect((await s.exchange(cousin.url, 'p_leo')).statusCode).toBe(401);
    // Revoked: the session ends at once, the link opens nothing.
    expect((await s.person('p_sam').send('DELETE', `/api/links/${mia.link.id}`)).statusCode).toBe(204);
    expect((await s.guest(g).get('/api/guest')).statusCode).toBe(401);
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

  it('a link opens on one device: the first exchange spends it, its maker sees it opened, and it is audited (review N2)', async () => {
    const db = household();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' })).json();
    expect(made.link.openedAt).toBeNull();
    // Refused exchanges spend nothing.
    expect((await s.exchange(made.url, 'p_robin')).statusCode).toBe(401);
    expect(db.select().from(t.guestLink).get()!.openedAt).toBeNull();
    const first = await s.exchange(made.url);
    expect(first.statusCode).toBe(200);
    const cookie = cookieOf(first);
    // Another browser, with or without a household session that may open it: opened elsewhere, no session made.
    for (const who of [undefined, 'p_sam']) {
      const again = await s.exchange(made.url, who);
      expect([again.statusCode, again.json(), again.headers['set-cookie']]).toEqual([409, { error: 'this link was opened on another device: ask whoever sent it for a new address' }, undefined]);
    }
    expect(db.select().from(t.guestSession).all()).toHaveLength(1);
    // The same browser following the link again: its own session goes on (the same cookie, no new session).
    const same = await s.inject({ method: 'POST', url: '/api/guest/session', payload: { token: made.url.split('#')[1] }, headers: { origin: ORIGIN, cookie } });
    expect([same.statusCode, cookieOf(same)]).toEqual([200, cookie]);
    expect(db.select().from(t.guestSession).all()).toHaveLength(1);
    // The session lasts as long as the link (a browser keeps a cookie 400 days at most).
    const row = db.select().from(t.guestSession).get()!;
    expect(new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()).toBe(400 * 86_400_000);
    // Its maker sees it opened; the opening is audited once, with the link as its actor.
    const listed = (await s.person('p_alex').get('/api/links')).json().links[0];
    expect(listed.openedAt).toBe(db.select().from(t.guestLink).get()!.openedAt);
    expect(listed.openedAt).not.toBeNull();
    expect(db.select().from(t.audit).all().filter((a) => a.action === 'link_opened').map((a) => [a.actorId, a.subjectId])).toEqual([[made.link.id, made.link.id]]);
    // A revoked link answers as unknown, opened or not.
    await ok(s.person('p_alex').send('DELETE', `/api/links/${made.link.id}`));
    expect((await s.exchange(made.url)).statusCode).toBe(401);
  });

  it('a draw link opened by its host spends it: the cousin is told it was opened on another device', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    // Alex is in the draw: in his browser, refused; on his phone (no household session) it opens, and spends the link.
    expect((await s.exchange(made.url, 'p_alex')).statusCode).toBe(401);
    expect((await s.exchange(made.url)).statusCode).toBe(200);
    expect((await s.exchange(made.url)).json().error).toBe('this link was opened on another device: ask whoever sent it for a new address');
    expect((await s.person('p_alex').get('/api/links')).json().links[0].openedAt).not.toBeNull();
  });

  it('one browser keeps every link it opened, back and forth; another device still gets the 409 (review M-a)', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    const s = await start(db);
    const robin = (await ok(s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' }))).json();
    const sam = (await ok(s.person('p_alex').send('POST', '/api/people/p_sam/links', { label: 'Godmother' }))).json();
    const cousin = (await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' }))).json();
    const first = await s.exchange(robin.url);
    const device = cookieOf(first);
    // The same device opens the others: its cookie stays the same.
    for (const l of [sam, cousin]) expect(cookieOf(await ok(s.exchange(l.url, undefined, device)))).toBe(device);
    const page = (linkId: string) => s.inject({ url: '/api/guest', headers: { cookie: device, 'x-keepsake-link': linkId } });
    for (let i = 0; i < 2; i++) {
      for (const [l, who] of [[robin, 'Robin'], [sam, 'Sam']] as const) expect((await ok(page(l.link.id))).json().person.name).toBe(who);
      expect((await ok(page(cousin.link.id))).json().kind).toBe('draw');
      // Following each link again from that device opens it again.
      for (const l of [robin, sam, cousin]) expect((await s.exchange(l.url, undefined, device)).statusCode).toBe(200);
    }
    expect(db.select().from(t.guestSession).all()).toHaveLength(3);
    // A link it did not open, or one the device never named: nothing.
    expect((await page('l_nope')).statusCode).toBe(401);
    expect((await s.inject({ url: '/api/guest', headers: { cookie: device } })).statusCode).toBe(401);
    // A third browser (and another device cookie) gets the 409 for each.
    for (const l of [robin, sam, cousin]) {
      expect((await s.exchange(l.url)).statusCode).toBe(409);
      expect((await s.exchange(l.url, undefined, `keepsake_guest=${'o'.repeat(43)}`)).statusCode).toBe(409);
    }
  });

  it('a guest session ends after 30 days unused, and goes on while used (review L-2)', async () => {
    const db = household();
    const s = await start(db);
    const made = (await ok(s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' }))).json();
    const t0 = Date.now();
    pin(new Date(t0));
    try {
      const g = s.guest(await s.exchange(made.url));
      for (const days of [29, 58]) { setNow(new Date(t0 + days * 86_400_000)); expect((await g.get('/api/guest')).statusCode, String(days)).toBe(200); }
      setNow(new Date(t0 + (58 + 30) * 86_400_000 + 60_000));
      expect((await g.get('/api/guest')).statusCode).toBe(401);
      expect(db.select().from(t.guestSession).all()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('a first exchange spends the link in one statement: a stale read never opens it twice', async () => {
    const db = household();
    const s = await start(db);
    const made = (await ok(s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' }))).json();
    const stale = db.select().from(t.guestLink).where(eq(t.guestLink.id, made.link.id)).get()!;
    expect((await s.exchange(made.url)).statusCode).toBe(200);
    // Read before it was opened, spent after: the conditional UPDATE refuses, and nothing is written.
    expect(() => openLink(db, stale, hashToken('d'.repeat(43)), new Date(), 'p_alex')).toThrow('this link was opened on another device');
    expect(db.select().from(t.guestSession).all()).toHaveLength(1);
    expect(db.select().from(t.audit).all().filter((a) => a.action === 'link_opened')).toHaveLength(1);
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
  const answer = async (h: Home, cookie: string, link: string, method: 'GET' | 'POST' = 'GET', url = '/api/guest', payload?: object) => {
    const r = await h.built.app.inject({ method, url, payload, headers: { cookie, origin: ORIGIN, 'x-keepsake-link': link } });
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
      expect(await answer(h, both, `l_${guest}`, m, u, b), u).toBe(await answer(h, unknown, `l_${guest}`, m, u, b));
    }
    expect(await answer(h, both, `l_${guest}`)).not.toContain('set-cookie');
    expect(h.db.select().from(t.question).all()).toEqual([]);
    // The session is gone: without the household session along it opens nothing either.
    expect((await as(h, guest).get('/api/guest')).statusCode).toBe(401);
    expect(h.db.select().from(t.guestSession).where(eq(t.guestSession.linkId, `l_${guest}`)).all()).toEqual([]);
  });

  it('with someone signed in who may see it (giving to its person), the guest session goes on', async () => {
    const h = await home();
    for (const [who, guest] of [['sam', 'gR'], ['robin', 'gM'], ['alex', 'gM']] as const) {
      const r = await h.built.app.inject({ url: '/api/guest', headers: { cookie: `${h.cookies[guest]}; ${h.cookies[who]}`, 'x-keepsake-link': `l_${guest}` } });
      expect([who, guest, r.statusCode, r.headers['set-cookie']]).toEqual([who, guest, 200, undefined]);
    }
  });

  it('a draw guest\'s session with someone of that draw signed in: refused like an unknown one', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    db.insert(t.person).values({ id: 'p_quinn', name: 'Quinn', role: 'adult', createdAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    const g = await s.exchange(made.url);
    const link = { 'x-keepsake-link': made.link.id };
    // A grown-up outside the draw: the session goes on.
    const quinn = await s.inject({ url: '/api/guest', headers: { cookie: `${cookieOf(g)}; ${sessionCookie(db, 'p_quinn')}`, ...link } });
    expect(quinn.statusCode).toBe(200);
    const sam = await s.inject({ url: '/api/guest', headers: { cookie: `${cookieOf(g)}; ${sessionCookie(db, 'p_sam')}`, ...link } });
    const unknown = await s.inject({ url: '/api/guest', headers: { cookie: `keepsake_guest=${'u'.repeat(43)}; ${sessionCookie(db, 'p_sam')}`, ...link } });
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
    const g = s.guest(await s.exchange(made.json().url));
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
    const g = s.guest(await s.exchange(made.url));
    const page = (await ok(g.send('POST', '/api/guest/draw/open'))).json();
    const wish = page.wishes[0];
    expect(wish).toBeDefined();
    await ok(g.send('PUT', `/api/guest/wishes/${wish.id}/claim`, { quantity: 1 }));
    const viewer = ['p_alex', 'p_sam', 'p_robin'].find((p) => p !== page.person.id)!;
    const c = (await s.person(viewer).get(`/api/people/${page.person.id}`)).json().wishes.find((w: { id: string }) => w.id === wish.id).gift.claims[0];
    expect(c).toMatchObject({ giver: null, guest: null, quantity: 1 });
  });
});

describe('a new address for a link (review M-b)', () => {
  it('its managers give the same link a new token: the old address and session end, the new one opens on one device', async () => {
    const db = household();
    const s = await start(db);
    const made = (await ok(s.person('p_alex').send('POST', '/api/people/p_robin/links', { label: 'Godmother' }))).json();
    const g = s.guest(await s.exchange(made.url));
    await ok(g.send('PUT', '/api/guest/name', { name: 'Ada' }));
    // Not the person, not a kid, not another grown-up: the 404 of none.
    for (const who of ['p_robin', 'p_mia', 'p_sam']) expect((await s.person(who).send('POST', `/api/links/${made.link.id}/address`)).statusCode, who).toBe(404);
    const again = await ok(s.person('p_alex').send('POST', `/api/links/${made.link.id}/address`));
    const fresh = again.json();
    expect(fresh.link).toMatchObject({ id: made.link.id, label: 'Godmother', guestName: 'Ada', openedAt: null, revokedAt: null });
    expect(fresh.url).not.toBe(made.url);
    expect((await g.get('/api/guest')).statusCode).toBe(401);
    expect((await s.exchange(made.url)).statusCode).toBe(401);
    const h = await s.exchange(fresh.url);
    expect([h.statusCode, h.json().name]).toEqual([200, 'Ada']);
    expect((await s.exchange(fresh.url)).statusCode).toBe(409);
    expect(db.select().from(t.audit).all().filter((a) => a.subjectId === made.link.id).map((a) => [a.action, a.actorId]))
      .toEqual([['link_created', 'p_alex'], ['link_opened', made.link.id], ['link_reissued', 'p_alex'], ['link_opened', made.link.id]]);
    // A revoked link gets no new address.
    await ok(s.person('p_alex').send('DELETE', `/api/links/${made.link.id}`));
    expect((await s.person('p_alex').send('POST', `/api/links/${made.link.id}/address`)).statusCode).toBe(404);
  });

  it('only whoever may make the link now gives it a new address: an admin in the draw who is not its host gets the invite\'s 403 (review R-1)', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    // Sam hosts Christmas; Alex (an admin) is in its draw; Quinn is an admin outside it.
    db.update(t.celebration).set({ hostId: 'p_sam' }).where(eq(t.celebration.id, 'c_xmas')).run();
    db.insert(t.person).values({ id: 'p_quinn', name: 'Quinn', role: 'admin', createdAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await ok(s.person('p_sam').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' }))).json();
    await ok(s.person('p_sam').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const g = s.guest(await s.exchange(made.url));
    await ok(g.send('POST', '/api/guest/draw/open'));
    for (const admin of ['p_alex', 'p_quinn']) {
      const invite = await s.person(admin).send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ben' });
      const reissue = await s.person(admin).send('POST', `/api/links/${made.link.id}/address`);
      expect([admin, reissue.statusCode, reissue.body]).toEqual([admin, 403, invite.body]);
      expect(invite.statusCode).toBe(403);
      // Revoking stays theirs (the link is listed to admins).
      expect((await s.person(admin).get('/api/links')).json().links.map((l: { id: string }) => l.id)).toContain(made.link.id);
    }
    // Nothing changed: the cousin's session goes on; the host may reissue.
    expect((await g.get('/api/guest')).statusCode).toBe(200);
    expect(db.select().from(t.audit).all().filter((a) => a.action === 'link_reissued')).toEqual([]);
    const before = (await ok(g.get('/api/guest'))).json();
    expect(before.reissued).toBeNull();
    const fresh = (await ok(s.person('p_sam').send('POST', `/api/links/${made.link.id}/address`))).json();
    // The reissue shows: in the host's list (when, how often), and on the guest's new page (with the earlier one's last use).
    const today = new Date().toISOString().slice(0, 10);
    expect(fresh.link).toMatchObject({ reissueCount: 1, openedAt: null });
    expect(fresh.link.reissuedAt.slice(0, 10)).toBe(today);
    expect((await s.person('p_sam').get('/api/links')).json().links.find((l: { id: string }) => l.id === made.link.id)).toMatchObject({ reissueCount: 1, reissuedAt: fresh.link.reissuedAt });
    expect((await ok(s.exchange(fresh.url))).json().reissued).toEqual({ on: today, earlierLastUsedOn: today });
    // Two more, the first of them never opened before the next: the page says the earlier one was never opened.
    await ok(s.person('p_sam').send('POST', `/api/links/${made.link.id}/address`));
    const fourth = (await ok(s.person('p_sam').send('POST', `/api/links/${made.link.id}/address`))).json();
    expect(fourth.link.reissueCount).toBe(3);
    expect((await ok(s.exchange(fourth.url))).json().reissued).toEqual({ on: today, earlierLastUsedOn: null });
    // Share links: the creation rule. A kid's link (Sam is Mia's parent): an admin who is not her parent gets its 403.
    const mia = (await ok(s.person('p_sam').send('POST', '/api/people/p_mia/links', { label: 'Granny' }))).json();
    const make = await s.person('p_alex').send('POST', '/api/people/p_mia/links', { label: 'Granny' });
    expect([(await s.person('p_alex').send('POST', `/api/links/${mia.link.id}/address`)).body]).toEqual([make.body]);
    const robin = (await ok(s.person('p_sam').send('POST', '/api/people/p_robin/links', { label: 'Neighbours' }))).json();
    expect((await s.person('p_alex').send('POST', `/api/links/${robin.link.id}/address`)).statusCode).toBe(200);
  });

  it('a drawn draw keeps the guest\'s place, pair and claims: no re-draw and no second participant', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    for (const p of ['alex', 'sam', 'robin', 'mia']) db.insert(t.wish).values({ id: `w_${p}_xmas`, personId: `p_${p}`, celebrationId: 'c_xmas', name: 'A puzzle', state: 'listed', position: 9, addedBy: `p_${p}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }).run();
    const s = await start(db);
    const made = (await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' }))).json();
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const g = s.guest(await s.exchange(made.url));
    const person = (await ok(g.send('POST', '/api/guest/draw/open'))).json().person.id as string;
    await ok(g.send('PUT', `/api/guest/wishes/w_${person.slice(2)}_xmas/claim`, { quantity: 1 }));
    // Her second device is refused; the host gives the link a new address.
    expect((await s.exchange(made.url)).statusCode).toBe(409);
    const before = { draw: db.select().from(t.draw).get(), participants: db.select().from(t.drawParticipant).all(), pairs: db.select().from(t.drawAssignment).all() };
    const fresh = (await ok(s.person('p_alex').send('POST', `/api/links/${made.link.id}/address`))).json();
    expect({ draw: db.select().from(t.draw).get(), participants: db.select().from(t.drawParticipant).all(), pairs: db.select().from(t.drawAssignment).all() }).toEqual(before);
    expect(before.participants.filter((p) => p.kind === 'guest')).toHaveLength(1);
    // On the new device: the same person, opened already, and her claim is hers.
    const page = (await ok(s.exchange(fresh.url))).json();
    expect([page.person.id, page.draw.opened]).toEqual([person, true]);
    expect(page.wishes.find((w: { id: string }) => w.id === `w_${person.slice(2)}_xmas`).gift.claims).toEqual([expect.objectContaining({ mine: true, state: 'claimed' })]);
    expect((await s.person('p_alex').get('/api/celebrations/c_xmas/draw')).json()).toMatchObject({ total: 5, guests: ['Cousin Ada'] });
  });

  it('the person and kids get the same answers whether a link to the person\'s wishes was given a new address', async () => {
    const [a, none] = [await home(), await home()];
    await ok(as(a, 'alex').send('POST', '/api/links/l_gR/address'));
    await ok(as(a, 'sam').send('POST', '/api/links/l_gM/address'));
    for (const v of ['robin', 'mia', 'leo'] as const) {
      const [x, y] = [await reads(a, v), await reads(none, v)];
      for (const k of Object.keys(x)) expect(x[k], `${v} ${k}`).toBe(y[k]);
    }
  }, 30_000);
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
    const g = s.guest(await s.exchange(made.url));
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

describe('a wish moved out of a draw guest\'s reach (review L-a)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('their only-made claim goes and a bought one stays unnamed; the person and kids learn nothing', async () => {
    pin(new Date());
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    // Another celebration everyone in the draw is part of, to move a Christmas wish to.
    db.insert(t.celebration).values({ id: 'c_summer', name: 'Summer party', date: inDays(60), poster: 'gold', recurrence: 'none', hostId: 'p_alex', createdAt: '2026-11-01T10:00:00.000Z' }).run();
    for (const p of ['alex', 'sam', 'robin', 'mia']) {
      db.insert(t.celebrationPerson).values({ celebrationId: 'c_summer', personId: `p_${p}` }).run();
      for (const n of ['1', '2']) db.insert(t.wish).values({ id: `w_${p}_xmas${n}`, personId: `p_${p}`, celebrationId: 'c_xmas', name: `A puzzle ${n}`, state: 'listed', position: 8 + Number(n), addedBy: `p_${p}`, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }).run();
    }
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    await ok(s.person('p_alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    const g = s.guest(await s.exchange(made.url));
    const person = (await ok(g.send('POST', '/api/guest/draw/open'))).json().person.id as string;
    const p = person.slice(2);
    // Whoever keeps the person's list moves the wishes: a kid's parent for Mia.
    const mover = person === 'p_mia' ? 'p_sam' : person;
    // Who may not know: the person and kids (a kid's parent sees the kid's gifts, so their answers are not compared).
    const viewers = [...new Set([person, 'p_mia', 'p_leo'])];
    const cookies = Object.fromEntries([...new Set([...viewers, mover])].map((v) => [v, sessionCookie(db, v)]));
    // The twin: the same household up to here, without the guest's claims.
    const twinDb = drizzle(new Database(db.$client.serialize()), { schema: t }) as unknown as Db;
    twinDb.$client.pragma('foreign_keys = ON');
    const twin = await buildApp(standalone(), twinDb);
    apps.push(twin);
    await ok(g.send('PUT', `/api/guest/wishes/w_${p}_xmas1/claim`, { quantity: 1 }));
    await ok(g.send('PUT', `/api/guest/wishes/w_${p}_xmas2/claim`, { quantity: 1 }));
    await ok(g.send('PATCH', `/api/guest/wishes/w_${p}_xmas2/claim`, { state: 'bought' }));
    const answers = async (inject: typeof s.inject) => {
      const out: string[] = [];
      for (const n of ['1', '2']) {
        const r = await inject({ method: 'PATCH', url: `/api/wishes/w_${p}_xmas${n}`, payload: { celebrationId: 'c_summer' }, headers: { cookie: cookies[mover]!, origin: ORIGIN } });
        if (mover === person) out.push(`${r.statusCode} ${r.body}`);
        else expect(r.statusCode).toBe(200);
      }
      for (const v of viewers) for (const u of ['/api/home', `/api/people/${person}`, `/api/people/${person}?for=c_summer`, '/api/celebrations/c_summer']) {
        const r = await inject({ url: u, headers: { cookie: cookies[v]! } });
        out.push(`${v} ${u} ${r.statusCode} ${r.body} ${JSON.stringify(Object.entries(r.headers).filter(([k]) => k !== 'date').sort())}`);
      }
      return out;
    };
    const [x, y] = [await answers(s.inject), await answers(twin.app.inject.bind(twin.app))];
    expect(x).toEqual(y);
    // The only-made claim went: the household may claim it; the bought one stays, with nobody's name.
    expect(db.select().from(t.claim).all().filter((c) => c.wishId.includes('_xmas')).map((c) => [c.wishId, c.state, c.guestId, c.giverId])).toEqual([[`w_${p}_xmas2`, 'bought', null, null]]);
    const other = ['p_alex', 'p_sam', 'p_robin'].find((q) => q !== person && q !== mover)!;
    expect((await s.person(other).send('PUT', `/api/wishes/w_${p}_xmas1/claim`, { quantity: 1 })).statusCode).toBe(200);
  });
});

describe('a wish waiting for a parent stays within a guest\'s reach', () => {
  it('a kid\'s change sends her wish back to a parent: the guest\'s claim stays, and is theirs again once approved', async () => {
    const h = await home();
    await ok(as(h, 'gM').send('PUT', '/api/guest/wishes/w_mia_bike/claim', { quantity: 1 }));
    await ok(as(h, 'mia').send('PATCH', '/api/wishes/w_mia_bike', { note: 'A blue one' }));
    expect(h.db.select().from(t.wish).where(eq(t.wish.id, 'w_mia_bike')).get()!.state).toBe('awaiting_parent');
    expect(h.db.select().from(t.claim).where(eq(t.claim.wishId, 'w_mia_bike')).all().map((c) => [c.guestId, c.state])).toEqual([['l_gM', 'claimed']]);
    await ok(as(h, 'sam').send('POST', '/api/wishes/w_mia_bike/approve'));
    expect((await as(h, 'gM').get('/api/guest')).json().wishes.find((w: { id: string }) => w.id === 'w_mia_bike').gift.claims).toEqual([expect.objectContaining({ mine: true })]);
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

describe('names that show nothing, and members named like guests (review L-b)', () => {
  it('format characters are refused in guests\' names and labels, and characters that show nothing never tell a name apart', async () => {
    const h = await home();
    for (const name of ['Robin\u200B', 'Ro\u200Bbin', 'Ro\u00ADbin', 'Rob\u2060in', 'Ada\u200D', 'Ada\uFEFF', 'Ad\u3164a', 'Ada\u180E'])
      expect((await as(h, 'gR').send('PUT', '/api/guest/name', { name })).json().error, JSON.stringify(name)).toBe('name: 1 to 60 characters, without control characters');
    expect((await as(h, 'alex').send('POST', '/api/people/p_robin/links', { label: 'Gran\u00ADny' })).json().error).toBe('label: 1 to 60 characters, without control characters');
    // Invisible marks that are not format characters (a grapheme joiner, a variation selector) still compare away.
    for (const name of ['Ro\u034Fbin', 'Robin\uFE0F']) expect((await as(h, 'gR').send('PUT', '/api/guest/name', { name })).json().error, JSON.stringify(name)).toBe('someone in the household has that name: add something to tell them apart');
    const { sameName } = await import('../src/guests/guests');
    expect(sameName('Ro\u00ADbin', 'robin')).toBe(true);
    expect(sameName('Rob\u2060in', 'ROBIN')).toBe(true);
  });

  it('a new member (or a new name) like a guest the admin sees is refused until confirmed; a guest on the admin\'s own wishes never shows', async () => {
    const h = await home();
    await ok(as(h, 'gR').send('PUT', '/api/guest/name', { name: 'Ada' }));
    for (const name of ['Ada', ' ada ', 'Guest gM']) {
      const r = await as(h, 'alex').send('POST', '/api/people', { name, role: 'adult' });
      expect([name, r.statusCode, r.json().error]).toEqual([name, 409, 'a guest by link has that name: add something to tell them apart, or confirm']);
    }
    expect((await as(h, 'alex').send('PATCH', '/api/people/p_quinn', { name: 'ADA' })).statusCode).toBe(409);
    expect((await ok(as(h, 'alex').send('PATCH', '/api/people/p_quinn', { name: 'ADA', confirmName: true }))).json().name).toBe('ADA');
    expect((await as(h, 'alex').send('POST', '/api/people', { name: 'Ada', role: 'adult', confirmName: true })).statusCode).toBe(201);
    // A guest of a link to Alex's own wishes (made by Sam): Alex never lists it, so nothing tells him of it.
    const own = (await ok(as(h, 'sam').send('POST', '/api/people/p_alex/links', { label: 'Neighbours' }))).json();
    const g = await h.built.app.inject({ method: 'POST', url: '/api/guest/session', payload: { token: own.url.split('#')[1] }, headers: { origin: ORIGIN } });
    await ok(h.built.app.inject({ method: 'PUT', url: '/api/guest/name', payload: { name: 'Bea' }, headers: { origin: ORIGIN, cookie: cookieOf(g), 'x-keepsake-link': own.link.id } }));
    expect((await as(h, 'alex').send('POST', '/api/people', { name: 'Bea', role: 'adult' })).statusCode).toBe(201);
  });
});

describe('a draw guest\'s profiles', () => {
  it('none before their draw is opened, then their own person\'s only: nobody else\'s changes a byte', async () => {
    const db = withDraws(household());
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    const s = await start(db);
    const made = (await s.person('p_alex').send('POST', '/api/celebrations/c_xmas/guests', { name: 'Cousin Ada' })).json();
    const g = s.guest(await s.exchange(made.url));
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
