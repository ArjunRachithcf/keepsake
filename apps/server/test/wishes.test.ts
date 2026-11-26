// Wishes (ADR 0007) and who sees them (ADR 0003's view layer): a kid's new wish waits for a manager, a suggestion for
// its person, and neither reaches anyone else in any answer. The matrix asserts on the raw response bytes.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import * as t from '../src/db/schema';
import { MAX_SUGGESTIONS, MAX_WISHES } from '../src/wishes/wishes';
import type { Db } from '../src/db/open';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

let built: BuiltApp;
let db: Db;
let cookies: Record<string, string>;
const PEOPLE = ['alex', 'sam', 'robin', 'mia', 'leo'] as const;
type Who = (typeof PEOPLE)[number];

async function fresh() {
  if (built) await built.app.close();
  db = household();
  cookies = Object.fromEntries(PEOPLE.map((p) => [p, sessionCookie(db, `p_${p}`)]));
  built = await buildApp(standalone(), db);
}
const as = (who: Who) => ({
  get: (url: string) => built.app.inject({ url, headers: { cookie: cookies[who]! } }),
  send: (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    built.app.inject({ method, url, payload, headers: { cookie: cookies[who]!, origin: ORIGIN } }),
});
afterAll(() => built?.app.close());

describe('who sees what (raw responses, every reading route)', () => {
  beforeAll(fresh);
  const READS = ['/api/home', '/api/home?for=c_xmas', '/api/household', '/api/celebrations',
    ...['alex', 'sam', 'robin', 'mia', 'leo'].flatMap((p) => [`/api/people/p_${p}`, `/api/people/p_${p}?for=c_xmas`]),
    '/api/celebrations/c_xmas', '/api/celebrations/c_mia'];
  const everything = async (who: Who) => (await Promise.all(READS.map(async (u) => {
    const r = await as(who).get(u);
    expect(r.statusCode, `${who} ${u}: ${r.body}`).toBe(200);
    return r.body;
  }))).join('\n');

  // [what, its id, who may see it]
  const CASES: [string, string, Who[]][] = [
    ['Glitter slime kit', 'w_mia_slime', ['mia', 'sam']], // a kid's waiting wish: the kid and her manager (not the admin)
    ['A dragon kite', 'w_leo_kite', ['leo', 'alex']], // no manager set: the admins
    ['A bread course', 'w_sug_for_alex', ['alex', 'robin']], // a suggestion: its person and who suggested it
    ['A paint set', 'w_sug_for_mia', ['mia', 'sam', 'robin']], // a suggestion for a kid: the kid, her manager, the suggester
    ['A two-person tent', 'w_alex_tent', [...PEOPLE]],
    ['A red bike', 'w_mia_bike', [...PEOPLE]],
  ];
  it.each(PEOPLE)('as %s', async (who) => {
    const body = await everything(who);
    for (const [name, id, allowed] of CASES) {
      expect(body.includes(name), `${who} sees ${name}`).toBe(allowed.includes(who));
      expect(body.includes(id), `${who} sees ${id}`).toBe(allowed.includes(who));
    }
  });
  it('a hidden wish is a 404 to change, approve or remove, the same as one that does not exist', async () => {
    for (const [method, url] of [['PATCH', '/api/wishes/w_mia_slime'], ['POST', '/api/wishes/w_mia_slime/approve'], ['DELETE', '/api/wishes/w_mia_slime']] as const) {
      const hidden = await as('robin').send(method, url, method === 'PATCH' ? { note: 'x' } : undefined);
      const none = await as('robin').send(method, url.replace('w_mia_slime', 'w_nothing'), method === 'PATCH' ? { note: 'x' } : undefined);
      expect([hidden.statusCode, hidden.body]).toEqual([none.statusCode, none.body]);
      expect(hidden.statusCode).toBe(404);
    }
  });
  it('a celebration counts only the caller\'s own approvals', async () => {
    const xmas = async (who: Who) => (await as(who).get('/api/celebrations')).json().upcoming.find((c: { id: string }) => c.id === 'c_xmas').toApprove;
    expect(await xmas('sam')).toBe(1);
    expect(await xmas('alex')).toBe(0);
    expect(await xmas('robin')).toBe(0);
  });
});

describe('adding, approving, declining', () => {
  beforeEach(fresh);
  const add = (who: Who, body: object) => as(who).send('POST', '/api/wishes', { celebrationId: null, ...body });

  it('your own is listed; a kid\'s waits; a manager\'s for the kid is listed; anyone else\'s is a suggestion', async () => {
    expect((await add('robin', { personId: 'p_robin', name: 'Wool hat' })).json()).toMatchObject({ state: 'listed', addedBy: null, canEdit: true });
    expect((await add('mia', { personId: 'p_mia', name: 'Unicorn mug' })).json()).toMatchObject({ state: 'awaiting_parent' });
    expect((await add('sam', { personId: 'p_mia', name: 'Swim goggles' })).json()).toMatchObject({ state: 'listed', addedBy: { id: 'p_sam', name: 'Sam' } });
    expect((await add('alex', { personId: 'p_mia', name: 'Puzzle' })).json()).toMatchObject({ state: 'suggested' }); // admin, but Mia has a manager
    expect((await add('alex', { personId: 'p_leo', name: 'Yo-yo' })).json()).toMatchObject({ state: 'listed' }); // no manager: the admins
    expect((await add('mia', { personId: 'p_alex', name: 'A drawing book' })).json()).toMatchObject({ state: 'suggested', addedBy: { name: 'Mia' } });
  });

  it('a suggestion: its person says yes (listed) or no (gone); nobody else may', async () => {
    expect((await as('sam').send('POST', '/api/wishes/w_sug_for_alex/approve')).statusCode).toBe(404);
    expect((await as('robin').send('POST', '/api/wishes/w_sug_for_alex/approve')).statusCode).toBe(403);
    const home = (await as('alex').get('/api/home')).json();
    expect(home.suggestions.map((w: { id: string }) => w.id)).toEqual(['w_sug_for_alex']);
    expect(home.wishes.map((w: { id: string }) => w.id)).not.toContain('w_sug_for_alex');
    expect((await as('robin').get('/api/home')).json().suggested.map((w: { id: string }) => w.id).sort()).toEqual(['w_sug_for_alex', 'w_sug_for_mia']);
    const yes = await as('alex').send('POST', '/api/wishes/w_sug_for_alex/approve');
    expect(yes.json()).toMatchObject({ state: 'listed', addedBy: { name: 'Robin' } });
    expect((await as('sam').get('/api/people/p_alex')).body).toContain('A bread course');
    expect((await as('robin').send('POST', '/api/wishes/w_sug_for_mia/decline')).statusCode).toBe(403);
    expect((await as('sam').send('POST', '/api/wishes/w_sug_for_mia/decline')).statusCode).toBe(204);
    expect((await as('robin').get('/api/home')).json().suggested).toEqual([]);
  });

  it('a kid\'s yes to a suggestion still waits for a manager; the manager\'s yes lists it', async () => {
    expect((await as('mia').send('POST', '/api/wishes/w_sug_for_mia/approve')).json().state).toBe('awaiting_parent');
    expect((await as('robin').get('/api/people/p_mia')).body).not.toContain('A paint set');
    expect((await as('sam').get('/api/home')).json().toApprove.map((w: { id: string }) => w.id).sort()).toEqual(['w_mia_slime', 'w_sug_for_mia']);
    expect((await as('mia').send('POST', '/api/wishes/w_sug_for_mia/approve')).statusCode).toBe(403);
    expect((await as('sam').send('POST', '/api/wishes/w_sug_for_mia/approve')).json().state).toBe('listed');
    expect((await as('robin').get('/api/people/p_mia')).body).toContain('A paint set');
  });

  it('a kid\'s change to a listed wish goes back to a manager', async () => {
    const r = await as('mia').send('PATCH', '/api/wishes/w_mia_bike', { name: 'A red bike with a bell' });
    expect(r.json().state).toBe('awaiting_parent');
    expect((await as('robin').get('/api/people/p_mia')).body).not.toContain('A red bike');
    expect((await as('sam').send('POST', '/api/wishes/w_mia_bike/approve')).json().state).toBe('listed');
  });

  it('changing and removing: the keeper (a kid\'s manager too); a suggestion only by whoever made it', async () => {
    expect((await as('sam').send('PATCH', '/api/wishes/w_alex_tent', { note: 'x' })).statusCode).toBe(403);
    expect((await as('sam').send('PATCH', '/api/wishes/w_mia_bike', { quantity: 2 })).json().quantity).toBe(2);
    expect((await as('alex').send('PATCH', '/api/wishes/w_sug_for_alex', { note: 'x' })).statusCode).toBe(403);
    expect((await as('robin').send('PATCH', '/api/wishes/w_sug_for_alex', { note: 'Saturday mornings' })).json().note).toBe('Saturday mornings');
    expect((await as('alex').send('DELETE', '/api/wishes/w_sug_for_alex')).statusCode).toBe(403);
    expect((await as('robin').send('DELETE', '/api/wishes/w_sug_for_alex')).statusCode).toBe(204);
    expect((await as('alex').send('DELETE', '/api/wishes/w_alex_old')).statusCode).toBe(204);
  });

  it('a wish is for a celebration its person is part of, or any time; moving it keeps it', async () => {
    expect((await add('alex', { personId: 'p_alex', name: 'Cake', celebrationId: 'c_mia' })).statusCode).toBe(400);
    expect((await add('alex', { personId: 'p_alex', name: 'Cake', celebrationId: 'c_nothing' })).statusCode).toBe(400);
    expect((await add('alex', { personId: 'p_alex', name: 'Cake' })).statusCode).toBe(201);
    expect((await as('alex').send('PATCH', '/api/wishes/w_alex_tent', { celebrationId: null })).json()).toMatchObject({ celebrationId: null, name: 'A two-person tent', mostWanted: true });
  });

  it('a price waits for the household\'s currency; only admins set it', async () => {
    expect((await add('sam', { personId: 'p_sam', name: 'Scarf', priceMinor: 3500 })).statusCode).toBe(409);
    expect((await as('sam').send('PATCH', '/api/household', { currency: 'EUR' })).statusCode).toBe(403);
    expect((await as('alex').send('PATCH', '/api/household', { currency: 'eur' })).statusCode).toBe(400);
    expect((await as('alex').send('PATCH', '/api/household', { currency: 'EUR' })).json().currency).toBe('EUR');
    expect((await add('sam', { personId: 'p_sam', name: 'Scarf', priceMinor: 3500 })).json().priceMinor).toBe(3500);
  });

  it('a link is a web address without credentials, kept as typed (never fetched)', async () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', 'ftp://shop.example/x', 'https://user:pw@shop.example/x', 'not a link', `https://shop.example/${'a'.repeat(2000)}`]) {
      expect((await add('sam', { personId: 'p_sam', name: 'Scarf', link })).statusCode, link).toBe(400);
    }
    expect((await add('sam', { personId: 'p_sam', name: 'Scarf', link: 'https://shop.example/scarf?colour=green' })).json().link).toBe('https://shop.example/scarf?colour=green');
  });

  it('fields are checked: unknown ones, empty names, quantities', async () => {
    for (const body of [{ personId: 'p_sam', name: '' }, { personId: 'p_sam', name: 'x', quantity: 0 }, { personId: 'p_sam', name: 'x', quantity: 100 },
      { personId: 'p_sam', name: 'x', claimedBy: 'p_alex' }, { personId: 'p_sam', name: 'x', mostWanted: 'yes' }, { name: 'x' }]) {
      expect((await add('sam', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await add('sam', { personId: 'p_nobody', name: 'x' })).statusCode).toBe(404);
  });

  it('the order is the keeper\'s: each of the person\'s wishes once', async () => {
    expect((await as('alex').send('PUT', '/api/people/p_alex/wish-order', { wishIds: ['w_alex_tent'] })).statusCode).toBe(400);
    expect((await as('alex').send('PUT', '/api/people/p_alex/wish-order', { wishIds: ['w_alex_tent', 'w_alex_tent'] })).statusCode).toBe(400);
    expect((await as('robin').send('PUT', '/api/people/p_alex/wish-order', { wishIds: ['w_alex_old', 'w_alex_tent'] })).statusCode).toBe(403);
    expect((await as('alex').send('PUT', '/api/people/p_alex/wish-order', { wishIds: ['w_alex_old', 'w_alex_tent'] })).statusCode).toBe(204);
    expect((await as('sam').get('/api/people/p_alex')).json().wishes.map((w: { id: string }) => w.id)).toEqual(['w_alex_old', 'w_alex_tent']);
  });
});

describe('a celebration\'s list: its wishes plus the any-time ones (computed)', () => {
  beforeAll(fresh);
  const names = (ws: { name: string }[]) => ws.map((w) => w.name).sort();
  it('a person\'s page by chip', async () => {
    expect(names((await as('sam').get('/api/people/p_alex')).json().wishes)).toEqual(['A two-person tent', 'Hiking socks']);
    expect(names((await as('sam').get('/api/people/p_alex?for=c_xmas')).json().wishes)).toEqual(['A two-person tent', 'Hiking socks']);
    expect(names((await as('sam').get('/api/people/p_alex?for=any')).json().wishes)).toEqual(['Hiking socks']);
    expect(names((await as('robin').get('/api/people/p_mia?for=c_xmas')).json().wishes)).toEqual([]);
    expect(names((await as('sam').get('/api/people/p_mia?for=c_xmas')).json().wishes)).toEqual(['Glitter slime kit']);
    expect(names((await as('sam').get('/api/people/p_mia?for=c_mia')).json().wishes)).toEqual(['A red bike']);
    expect((await as('sam').get('/api/people/p_alex?for=c_nothing')).statusCode).toBe(400);
    expect((await as('sam').get('/api/people/p_alex?for=%3Cscript%3E')).statusCode).toBe(400);
  });
  it('the celebration\'s page has each of its people\'s lists', async () => {
    const page = (await as('robin').get('/api/celebrations/c_xmas')).json();
    const byName = Object.fromEntries(page.lists.map((l: { person: { name: string }; wishes: { name: string }[] }) => [l.person.name, names(l.wishes)]));
    expect(byName).toEqual({ Alex: ['A two-person tent', 'Hiking socks'], Leo: [], Mia: [], Robin: [], Sam: ['A cast-iron pan', 'A cookbook'] });
    const sams = (await as('sam').get('/api/celebrations/c_xmas')).json();
    expect(sams.lists.find((l: { person: { name: string } }) => l.person.name === 'Mia').wishes.map((w: { name: string }) => w.name)).toEqual(['Glitter slime kit']);
  });
  it('home: the next celebration I am part of, my chips, my list', async () => {
    const home = (await as('mia').get('/api/home')).json();
    expect(home.next).toMatchObject({ upcoming: true });
    expect(home.celebrations.map((c: { id: string }) => c.id).sort()).toEqual(['c_mia', 'c_xmas']);
    expect(names(home.wishes)).toEqual(['A red bike', 'Glitter slime kit']);
    expect(names((await as('mia').get('/api/home?for=c_mia')).json().wishes)).toEqual(['A red bike']);
  });
});

describe('profiles', () => {
  beforeEach(fresh);
  it('kept by the person or a kid\'s manager; each part dated when it changes', async () => {
    expect((await as('robin').send('PUT', '/api/people/p_mia/profile', { likes: ['Horses'] })).statusCode).toBe(403);
    const a = (await as('sam').send('PUT', '/api/people/p_mia/profile', { sizes: [{ label: 'Shoes', value: 'EU 31' }], likes: ['Horses'] })).json();
    expect(a).toMatchObject({ sizes: [{ label: 'Shoes', value: 'EU 31' }], likes: ['Horses'], pleaseNo: [], pleaseNoUpdatedAt: null });
    expect(a.sizesUpdatedAt).toEqual(expect.any(String));
    const b = (await as('mia').send('PUT', '/api/people/p_mia/profile', { likes: ['Horses'], pleaseNo: ['Glitter'] })).json();
    expect(b.likesUpdatedAt).toBe(a.likesUpdatedAt);
    expect(b.pleaseNo).toEqual(['Glitter']);
    expect((await as('robin').get('/api/people/p_mia')).json().profile).toMatchObject({ likes: ['Horses'], pleaseNo: ['Glitter'] });
    expect((await as('sam').send('PUT', '/api/people/p_mia/profile', { sizes: [{ label: 'Shoes' }] })).statusCode).toBe(400);
  });
});

describe('the household', () => {
  beforeEach(fresh);
  it('managers: admins set them; only kids have them, only grown-ups are them; none means the admins', async () => {
    expect((await as('sam').send('PUT', '/api/people/p_leo/managers', { managerIds: ['p_sam'] })).statusCode).toBe(403);
    expect((await as('alex').send('PUT', '/api/people/p_sam/managers', { managerIds: ['p_robin'] })).statusCode).toBe(409);
    expect((await as('alex').send('PUT', '/api/people/p_leo/managers', { managerIds: ['p_mia'] })).statusCode).toBe(400);
    expect((await as('alex').send('PUT', '/api/people/p_leo/managers', { managerIds: ['p_robin'] })).json().managers).toEqual(['p_robin']);
    expect((await as('alex').get('/api/home')).json().toApprove).toEqual([]);
    expect((await as('robin').get('/api/home')).json().toApprove.map((w: { id: string }) => w.id)).toEqual(['w_leo_kite']);
  });
  it('a kid who grows up keeps their waiting wishes, listed, and has no managers', async () => {
    const r = await as('alex').send('PATCH', '/api/people/p_mia', { role: 'adult' });
    expect(r.json()).toMatchObject({ role: 'adult', managers: [] });
    expect((await as('robin').get('/api/people/p_mia')).body).toContain('Glitter slime kit');
  });
  it('people: admins only; removing someone removes their wishes', async () => {
    expect((await as('sam').send('POST', '/api/people', { name: 'Jordan', role: 'adult' })).statusCode).toBe(403);
    expect((await as('alex').send('POST', '/api/people', { name: 'Jordan', role: 'owner' })).statusCode).toBe(400);
    expect((await as('alex').send('DELETE', '/api/people/p_robin')).statusCode).toBe(204);
    // A suggestion of someone removed still waits for its person, from nobody now.
    expect((await as('alex').get('/api/home')).json().suggestions).toMatchObject([{ id: 'w_sug_for_alex', addedBy: null }]);
    expect((await as('alex').get('/api/household')).json().people.map((p: { name: string }) => p.name)).not.toContain('Robin');
  });
});

describe('names and entries shown to others (Gate routes L6)', () => {
  beforeEach(fresh);
  it('format and control characters are refused in member, wish and celebration names, places and profile entries', async () => {
    const zwsp = 'Sam\u200b', rlo = 'A \u202egnp.exe kite';
    const codes = [
      (await as('alex').send('POST', '/api/people', { name: zwsp, role: 'adult' })).statusCode,
      (await as('alex').send('PATCH', '/api/people/p_robin', { name: zwsp })).statusCode,
      (await as('alex').send('POST', '/api/wishes', { personId: 'p_alex', name: rlo, quantity: 1, mostWanted: false, celebrationId: null, link: null, priceMinor: null, note: null })).statusCode,
      (await as('alex').send('PATCH', '/api/wishes/w_alex_tent', { name: rlo })).statusCode,
      (await as('alex').send('POST', '/api/celebrations', { name: rlo, date: '2026-12-31', recurrence: 'none', poster: 'pine', people: ['p_alex'] })).statusCode,
      (await as('alex').send('PATCH', '/api/celebrations/c_xmas', { place: rlo })).statusCode,
      (await as('robin').send('PUT', '/api/people/p_robin/profile', { likes: [rlo] })).statusCode,
      (await as('robin').send('PUT', '/api/people/p_robin/profile', { sizes: [{ label: 'Shoes\u200b', value: '42' }] })).statusCode,
    ];
    expect(codes).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
    // The same without them goes through.
    expect((await as('alex').send('PATCH', '/api/wishes/w_alex_tent', { name: 'A kite' })).statusCode).toBe(200);
  });

  it('a new member named like another (case, accents and characters that show nothing aside) waits for a confirmation', async () => {
    const add = (name: string, confirmName?: boolean) => as('alex').send('POST', '/api/people', { name, role: 'adult', ...(confirmName ? { confirmName } : {}) });
    const r = await add('SÀM');
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'someone in the household has a name like that: add something to tell them apart, or confirm' }]);
    expect((await as('alex').send('PATCH', '/api/people/p_robin', { name: 'sam' })).statusCode).toBe(409);
    expect((await add('Sam K.')).statusCode).toBe(201);
    expect((await add('Sàm', true)).statusCode).toBe(201);
  });
});

describe('limits', () => {
  beforeEach(fresh);
  it('a list holds at most 300 wishes; one person keeps at most 30 suggestions waiting for another', async () => {
    const now = new Date().toISOString();
    db.insert(t.wish).values(Array.from({ length: MAX_WISHES - 2 }, (_, i) => ({ id: `w_bulk_${i}`, personId: 'p_alex', name: `Wish ${i}`, state: 'listed' as const, position: 10 + i, addedBy: 'p_alex', createdAt: now, updatedAt: now }))).run();
    expect((await as('alex').send('POST', '/api/wishes', { personId: 'p_alex', name: 'One more', celebrationId: null })).statusCode).toBe(409);
    // a suggestion waits outside the list, but saying yes needs room
    expect((await as('alex').send('POST', '/api/wishes/w_sug_for_alex/approve')).statusCode).toBe(409);
    // the whole list can still be ordered
    const ids = (await as('alex').get('/api/home')).json().wishes.map((w: { id: string }) => w.id).reverse();
    expect(ids).toHaveLength(MAX_WISHES);
    expect((await as('alex').send('PUT', '/api/people/p_alex/wish-order', { wishIds: ids })).statusCode).toBe(204);
    for (let i = 0; i < MAX_SUGGESTIONS - 1; i++) expect((await as('robin').send('POST', '/api/wishes', { personId: 'p_sam', name: `Idea ${i}`, celebrationId: null })).statusCode).toBe(201);
    expect((await as('robin').send('POST', '/api/wishes', { personId: 'p_sam', name: 'Too many', celebrationId: null })).statusCode).toBe(201);
    expect((await as('robin').send('POST', '/api/wishes', { personId: 'p_sam', name: 'Too many', celebrationId: null })).statusCode).toBe(409);
    expect((await as('mia').send('POST', '/api/wishes', { personId: 'p_sam', name: 'Mine is fine', celebrationId: null })).statusCode).toBe(201);
  });
});

describe('a one-off celebration that has passed (ADR 0007)', () => {
  beforeEach(fresh);
  it('lets go of its wishes: they are for any time now; a yearly one keeps its own', async () => {
    db.update(t.wish).set({ celebrationId: 'c_old' }).where(eq(t.wish.id, 'w_alex_old')).run();
    const socks = (await as('sam').get('/api/people/p_alex?for=any')).json().wishes.map((w: { id: string; celebrationId: string | null }) => [w.id, w.celebrationId]);
    expect(socks).toEqual([['w_alex_old', null]]);
    expect((await as('sam').get('/api/people/p_alex')).json().wishes.find((w: { id: string }) => w.id === 'w_alex_tent').celebrationId).toBe('c_xmas');
    expect((await as('mia').get('/api/home')).json().wishes.find((w: { id: string }) => w.id === 'w_mia_bike').celebrationId).toBe('c_mia');
  });
});
