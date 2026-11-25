// Claims and group gifts (spec §3) and ADR 0003's matrix on the raw response bytes: every reading route × viewer
// (the person, a kid's parent, another adult, a kid, an admin, the givers) × wish state (claimed, bought, given, a
// group gift with shares, after the celebration with and without a name). For whoever must not see gifts (the
// person, and kids), every answer is byte for byte the answer with no gifts at all, until the celebration is over.
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

const PEOPLE = ['alex', 'sam', 'robin', 'mia', 'leo', 'quinn', 'uma'] as const;
type Who = (typeof PEOPLE)[number];
const NOW = '2026-11-01T10:00:00.000Z';

let built: BuiltApp | undefined;
let db: Db;
let cookies: Record<string, string>;

/** household() plus two givers in no celebration, with no wishes (so their names appear only through gifts). */
async function fresh() {
  if (built) await built.app.close();
  db = household();
  db.insert(t.person).values([
    { id: 'p_quinn', name: 'Quinn', role: 'adult', createdAt: NOW },
    { id: 'p_uma', name: 'Uma', role: 'adult', createdAt: NOW },
  ]).run();
  db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
  cookies = Object.fromEntries(PEOPLE.map((p) => [p, sessionCookie(db, `p_${p}`)]));
  built = await buildApp(standalone(), db);
}
afterAll(() => built?.app.close());

const as = (who: Who) => ({
  get: (url: string) => built!.app.inject({ url, headers: { cookie: cookies[who]! } }),
  send: (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    built!.app.inject({ method, url, payload, headers: { cookie: cookies[who]!, origin: ORIGIN } }),
});
const ok = async (p: Promise<{ statusCode: number; body: string }>) => {
  const r = await p;
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r;
};

// Every reading route but the household's own list of people (which names Quinn and Uma by design).
const READS = ['/api/home', '/api/home?for=c_xmas', '/api/home?for=c_mia', '/api/home?for=any', '/api/celebrations',
  '/api/celebrations/c_xmas', '/api/celebrations/c_mia', '/api/auth/session',
  ...['alex', 'sam', 'robin', 'mia', 'leo'].flatMap((p) => [`/api/people/p_${p}`, `/api/people/p_${p}?for=c_xmas`, `/api/people/p_${p}?for=any`])];
async function reads(who: Who): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(READS.map(async (u) => {
    const r = await as(who).get(u);
    expect(r.statusCode, `${who} ${u}: ${r.body}`).toBe(200);
    return [u, r.body] as const;
  })));
}

// What only givers may learn: the givers' ids and names, each share, the total and the target.
const GIVERS = ['p_quinn', 'Quinn', 'p_uma', 'Uma'];
const AMOUNTS = { quinn: '4321', uma: '1357', total: '5678', target: '9753' };

// Two wishes: an adult's (Sam's cookbook, for Christmas) and a kid's (Mia's bike, for her birthday).
const TARGETS = {
  w_sam_book: { person: 'sam' as Who, past: '2025-12-24', shouldNot: ['sam', 'mia', 'leo'] as Who[], givers: ['alex', 'robin', 'quinn', 'uma'] as Who[] },
  w_mia_bike: { person: 'mia' as Who, past: '2026-03-14', shouldNot: ['mia', 'leo'] as Who[], givers: ['alex', 'sam', 'robin', 'quinn', 'uma'] as Who[] },
};
type Target = keyof typeof TARGETS;

const over = (wishId: string, past: string) => {
  db.update(t.claim).set({ forDate: past, givenOn: past }).where(eq(t.claim.wishId, wishId)).run();
  db.update(t.groupGift).set({ forDate: past, givenOn: past }).where(eq(t.groupGift.wishId, wishId)).run();
};
const group = async (w: string) => {
  await ok(as('quinn').send('POST', `/api/wishes/${w}/group`, { targetMinor: Number(AMOUNTS.target) }));
  await ok(as('quinn').send('PUT', `/api/wishes/${w}/group/share`, { amountMinor: Number(AMOUNTS.quinn) }));
  await ok(as('uma').send('PUT', `/api/wishes/${w}/group/share`, { amountMinor: Number(AMOUNTS.uma) }));
};
const claim = (w: string, state?: 'bought' | 'given') => async () => {
  await ok(as('quinn').send('PUT', `/api/wishes/${w}/claim`, { quantity: 1 }));
  if (state) await ok(as('quinn').send('PATCH', `/api/wishes/${w}/claim`, { state }));
};

/** Each state: how to get there, whether the celebration is over, whether Quinn's name is on it. */
const STATES: Record<string, { setup: (w: Target) => Promise<void>; isOver: boolean; named: boolean; given: boolean; group: boolean }> = {
  claimed: { setup: (w) => claim(w)(), isOver: false, named: false, given: false, group: false },
  bought: { setup: (w) => claim(w, 'bought')(), isOver: false, named: false, given: false, group: false },
  given: { setup: (w) => claim(w, 'given')(), isOver: false, named: false, given: true, group: false },
  'group gift with shares': { setup: group, isOver: false, named: false, given: false, group: true },
  'group gift given': { setup: async (w) => { await group(w); await ok(as('quinn').send('PATCH', `/api/wishes/${w}/group`, { state: 'given' })); }, isOver: false, named: false, given: true, group: true },
  'after the celebration, no name': { setup: async (w) => { await claim(w, 'given')(); over(w, TARGETS[w].past); }, isOver: true, named: false, given: true, group: false },
  'after the celebration, named': {
    setup: async (w) => { await claim(w, 'given')(); over(w, TARGETS[w].past); await ok(as('quinn').send('PUT', `/api/wishes/${w}/named`, { named: true })); },
    isOver: true, named: true, given: true, group: false,
  },
  'group gift after the celebration, Quinn named': {
    setup: async (w) => { await group(w); await ok(as('quinn').send('PATCH', `/api/wishes/${w}/group`, { state: 'given' })); over(w, TARGETS[w].past); await ok(as('quinn').send('PUT', `/api/wishes/${w}/named`, { named: true })); },
    isOver: true, named: true, given: true, group: true,
  },
};

const ALL = (b: Record<string, string>) => Object.values(b).join('\n');
/** Every answer but those of these routes (a route and its `?for=` forms). */
const without = (b: Record<string, string>, ...urls: string[]) => Object.entries(b).filter(([u]) => !urls.includes(u.split('?')[0]!)).map(([, v]) => v).join('\n');
/** Every object with this id in an answer. */
const withId = (body: string, id: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if ((v as { id?: unknown }).id === id) out.push(v as Record<string, unknown>); Object.values(v).forEach(walk); }
  };
  walk(JSON.parse(body));
  return out;
};

describe.each(Object.keys(TARGETS) as Target[])('the surprise for %s (raw responses)', (target) => {
  const T = TARGETS[target];
  const baseline: Partial<Record<Who, Record<string, string>>> = {};
  beforeEach(fresh);

  it('the baseline: no gifts', async () => {
    for (const who of PEOPLE) baseline[who] = await reads(who);
    // (Quinn and Uma's own session names them, of course.)
    for (const who of PEOPLE) for (const g of [...GIVERS, ...Object.values(AMOUNTS)]) expect(without(baseline[who]!, '/api/auth/session').includes(g), `${who}: ${g}`).toBe(false);
  });

  describe.each(Object.keys(STATES))('%s', (state) => {
    const S = STATES[state]!;
    it.each(PEOPLE)('as %s', async (who) => {
      await S.setup(target);
      const body = await reads(who);
      const all = ALL(body);
      const giver = T.givers.includes(who);
      if (!giver) {
        // The person and kids: before the celebration is over, exactly what they got with no gifts at all.
        if (!S.isOver) expect(body).toEqual(baseline[who]);
        else {
          const home = JSON.parse(body['/api/home']!) as { thanks: { wish: { id: string }; from: { name: string }[] }[] };
          // Received: gone from every list, the person's own included…
          expect(without(body, '/api/home').includes(target), `${who} still sees ${target}`).toBe(false);
          expect(JSON.parse(body['/api/home']!).wishes.map((w: { id: string }) => w.id)).not.toContain(target);
          // …and their thank-you names only who chose it; a kid who is not the person gets no thank-you for it.
          const thanks = home.thanks.filter((x) => x.wish.id === target);
          expect(thanks.length, `${who}'s thanks`).toBe(who === T.person ? 1 : 0);
          if (who === T.person) expect(thanks[0]!.from.map((p) => p.name)).toEqual(S.named ? ['Quinn'] : []);
        }
        // Never a share, a total, a target, Uma (never named), nor Quinn outside a thank-you she chose.
        for (const x of [...Object.values(AMOUNTS), 'p_uma', 'Uma']) expect(all.includes(x), `${who} sees ${x}`).toBe(false);
        const named = who === T.person && S.named;
        expect(without(body, '/api/home').includes('Quinn'), `${who} sees Quinn`).toBe(false);
        expect(body['/api/home']!.includes('Quinn'), `${who}'s home names Quinn`).toBe(named);
        for (const b of Object.values(body)) for (const w of withId(b, target)) expect(w, `${who} gets ${target}'s gifts`).not.toHaveProperty('gift');
        return;
      }
      // Givers: until it is all given, they see it with its gifts; given, it is gone from their lists.
      const listed = without(body, '/api/home', '/api/auth/session').includes(target);
      expect(listed, `${who} lists ${target}`).toBe(!S.given);
      if (!S.given) {
        expect(all.includes('Quinn'), `${who} sees Quinn`).toBe(true);
        if (S.group) {
          expect(all.includes(AMOUNTS.total) && all.includes(AMOUNTS.target), `${who} sees the total and target`).toBe(true);
          expect(all.includes('Uma')).toBe(true);
          // Others' shares are names, not amounts: each giver sees their own only.
          expect(all.includes(AMOUNTS.quinn), `${who} sees Quinn's share`).toBe(who === 'quinn');
          expect(all.includes(AMOUNTS.uma), `${who} sees Uma's share`).toBe(who === 'uma');
        }
      }
      if (S.isOver && (who === 'quinn' || (S.group && who === 'uma'))) {
        const gave = JSON.parse(body['/api/home']!).gave as { wish: { id: string }; named: boolean }[];
        expect(gave.find((g) => g.wish.id === target)).toMatchObject({ named: who === 'quinn' && S.named });
      }
    });
  });

  it('the person\'s and a kid\'s answer to every gift route is the same whatever the gifts are', async () => {
    const tries = [
      ['PUT', `/api/wishes/${target}/claim`, { quantity: 1 }], ['PATCH', `/api/wishes/${target}/claim`, { state: 'bought' }],
      ['DELETE', `/api/wishes/${target}/claim`], ['PUT', `/api/wishes/${target}/named`, { named: true }],
      ['POST', `/api/wishes/${target}/group`, { targetMinor: 100 }], ['PATCH', `/api/wishes/${target}/group`, { state: 'bought' }],
      ['DELETE', `/api/wishes/${target}/group`], ['PUT', `/api/wishes/${target}/group/share`, { amountMinor: 100 }],
      ['DELETE', `/api/wishes/${target}/group/share`],
    ] as const;
    const answers = async () => {
      const out: string[] = [];
      for (const who of T.shouldNot) {
        for (const [m, u, b] of tries) {
          // On a fresh copy each time, so one try cannot change the next.
          const r = await as(who).send(m, u, b);
          out.push(`${who} ${m} ${u} ${r.statusCode} ${r.body}`);
          expect(r.statusCode, `${who} ${m} ${u}`).toBe(403);
        }
      }
      // Changing the wish (its keeper): the same answer, but for the time it was changed.
      const r = await as(T.person).send('PATCH', `/api/wishes/${target}`, { note: 'Blue, please' });
      out.push(r.body.replace(/"updatedAt":"[^"]+"/, ''));
      return out;
    };
    await fresh();
    const none = await answers();
    for (const state of Object.keys(STATES)) {
      if (STATES[state]!.isOver) continue;
      await fresh();
      await STATES[state]!.setup(target);
      expect(await answers(), state).toEqual(none);
    }
  });
});

describe('claims', () => {
  beforeEach(fresh);
  const gift = async (who: Who, w: string) => (await as(who).get('/api/celebrations/c_xmas')).json().lists.flatMap((l: { wishes: { id: string; gift?: unknown }[] }) => l.wishes).find((x: { id: string }) => x.id === w)?.gift;

  it('I\'ll get this, bought, given, and back; others see who', async () => {
    const r = await as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 });
    expect(r.json().gift).toMatchObject({ claimed: 1, left: 0, given: false, claims: [{ giver: { name: 'Quinn' }, state: 'claimed', mine: true }], mine: { state: 'claimed', over: false, celebrationId: 'c_xmas', forDate: '2026-12-24' } });
    expect(await gift('robin', 'w_sam_book')).toMatchObject({ claims: [{ giver: { name: 'Quinn' }, mine: false }], mine: null });
    expect((await as('robin').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(409);
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'bought' })).json().gift.claims[0].state).toBe('bought');
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'given' })).json().gift.given).toBe(true);
    expect(await gift('robin', 'w_sam_book')).toBeUndefined(); // gone everywhere for givers
    expect((await as('quinn').send('DELETE', '/api/wishes/w_sam_book/claim')).statusCode).toBe(409);
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'claimed' })).json().gift.given).toBe(false);
    expect((await as('quinn').send('DELETE', '/api/wishes/w_sam_book/claim')).statusCode).toBe(204);
    expect((await as('quinn').send('DELETE', '/api/wishes/w_sam_book/claim')).statusCode).toBe(404);
  });

  it('how many: within what is left; given in part stays on the list for what is left', async () => {
    db.update(t.wish).set({ quantity: 3 }).where(eq(t.wish.id, 'w_sam_book')).run();
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 2 }));
    const tooMany = await as('uma').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 2 });
    expect([tooMany.statusCode, tooMany.json().error]).toEqual([409, 'not that many are left to claim']);
    expect((await as('uma').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).json().gift).toMatchObject({ claimed: 3, left: 0 });
    await ok(as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'given' }));
    expect(await gift('robin', 'w_sam_book')).toMatchObject({ given: false, claimed: 3 });
    // The person changing how many they want: no word about claims, whatever they are.
    // The person wants one now: no word about claims in their answer; for givers, the two given cover it, so it is gone.
    expect((await as('sam').send('PATCH', '/api/wishes/w_sam_book', { quantity: 1 })).json()).not.toHaveProperty('gift');
    expect(await gift('robin', 'w_sam_book')).toBeUndefined();
  });

  it('only a giver: not the person, not a kid; a kid\'s parent may; hidden wishes 404 like missing ones', async () => {
    expect((await as('sam').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(403);
    expect((await as('leo').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(403);
    expect((await as('sam').send('PUT', '/api/wishes/w_mia_bike/claim', { quantity: 1 })).statusCode).toBe(200);
    const hidden = await as('robin').send('PUT', '/api/wishes/w_mia_slime/claim', { quantity: 1 });
    const none = await as('robin').send('PUT', '/api/wishes/w_nothing/claim', { quantity: 1 });
    expect([hidden.statusCode, hidden.body]).toEqual([none.statusCode, none.body]);
    expect(hidden.statusCode).toBe(404);
    // A suggestion Robin made (he sees it) is not on the list yet.
    expect((await as('robin').send('PUT', '/api/wishes/w_sug_for_alex/claim', { quantity: 1 })).statusCode).toBe(409);
    for (const body of [{}, { quantity: 0 }, { quantity: 100 }, { quantity: 1, giver: 'p_uma' }]) {
      expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'lost' })).statusCode).toBe(400);
  });

  it('a removed wish takes its claims along, and the person\'s answer says nothing of them', async () => {
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 }));
    const r = await as('sam').send('DELETE', '/api/wishes/w_sam_book');
    expect([r.statusCode, r.body]).toEqual([204, '']);
    expect(db.select().from(t.claim).where(eq(t.claim.wishId, 'w_sam_book')).all()).toEqual([]);
  });

  it('moving a wish keeps its claims (ADR 0007); a claim left over from long ago counts for the next celebration', async () => {
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 }));
    await ok(as('sam').send('PATCH', '/api/wishes/w_sam_book', { celebrationId: null }));
    expect((await as('quinn').get('/api/people/p_sam')).json().wishes.find((w: { id: string }) => w.id === 'w_sam_book').gift.claims).toHaveLength(1);
    db.update(t.claim).set({ forDate: '2024-12-24' }).where(eq(t.claim.wishId, 'w_sam_book')).run();
    const g = (await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'given' })).json().gift;
    expect(g.mine).toMatchObject({ forDate: '2026-12-24', over: false });
    // …so Sam still sees it, as he did.
    expect((await as('sam').get('/api/home')).json().wishes.map((w: { id: string }) => w.id)).toContain('w_sam_book');
  });

  it('given a little late: the person learns it the next day', async () => {
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 }));
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    db.update(t.claim).set({ forDate: yesterday }).where(eq(t.claim.wishId, 'w_sam_book')).run();
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'given' })).json().gift.mine).toMatchObject({ forDate: yesterday, over: true });
    expect((await as('sam').get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id)).toEqual(['w_sam_book']);
    // Over: it stays given.
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'claimed' })).statusCode).toBe(409);
  });
});

describe('the name on a gift, after the celebration', () => {
  beforeEach(fresh);
  it('off by default; on only for a gift you gave once it is over; the person sees it to thank you', async () => {
    expect((await as('sam').get('/api/home')).json().thanks).toEqual([]);
    const robin = (await as('robin').get('/api/home')).json();
    expect(robin.thanks).toMatchObject([{ wish: { id: 'w_robin_scarf' }, celebration: { id: 'c_xmas', name: 'Christmas' }, on: '2025-12-24', from: [] }]);
    expect(robin.thanks[0].wish).not.toHaveProperty('gift');
    expect((await as('alex').get('/api/home')).json().gave).toMatchObject([{ wish: { id: 'w_robin_scarf', gift: { mine: { named: false, over: true } } }, named: false }]);
    expect((await as('quinn').send('PUT', '/api/wishes/w_robin_scarf/named', { named: true })).statusCode).toBe(409);
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 }));
    expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/named', { named: true })).statusCode).toBe(409);
    expect((await as('alex').send('PUT', '/api/wishes/w_robin_scarf/named', { named: true })).json().gift.mine.named).toBe(true);
    expect((await as('robin').get('/api/home')).json().thanks[0].from).toEqual([{ id: 'p_alex', name: 'Alex' }]);
    expect((await as('alex').send('PUT', '/api/wishes/w_robin_scarf/named', { named: false })).statusCode).toBe(200);
    expect((await as('robin').get('/api/home')).json().thanks[0].from).toEqual([]);
    // Nobody else's home has it.
    for (const who of ['sam', 'mia', 'leo', 'quinn'] as const) expect((await as(who).get('/api/home')).body, who).not.toContain('w_robin_scarf');
  });
});

describe('thank-yous for a kid\'s gifts', () => {
  beforeEach(fresh);
  it('go to the kid and the kid\'s parents, only after the occasion; nobody else', async () => {
    await claim('w_mia_bike', 'given')();
    const thanks = async (who: Who) => (await as(who).get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id);
    for (const who of ['mia', 'sam'] as const) expect(await thanks(who), `${who} before`).toEqual([]);
    over('w_mia_bike', '2026-03-14');
    await ok(as('quinn').send('PUT', '/api/wishes/w_mia_bike/named', { named: true }));
    expect(await thanks('mia')).toEqual(['w_mia_bike']);
    const sam = (await as('sam').get('/api/home')).json().thanks;
    expect(sam).toMatchObject([{ wish: { id: 'w_mia_bike', personId: 'p_mia' }, from: [{ name: 'Quinn' }] }]);
    expect(sam[0].wish).not.toHaveProperty('gift');
    // Alex is an admin, but Mia's parent is Sam; Robin and Leo are not hers.
    for (const who of ['alex', 'robin', 'leo'] as const) expect(await thanks(who), who).not.toContain('w_mia_bike');
  });
});

describe('group gifts', () => {
  beforeEach(fresh);
  const url = '/api/wishes/w_sam_book/group';
  it('start, chip in, see the total and who; the organizer runs it', async () => {
    expect((await as('quinn').send('POST', url, { targetMinor: 6000 })).json().gift.group).toMatchObject({ organizer: { name: 'Quinn' }, targetMinor: 6000, totalMinor: 0, state: 'open', canManage: true });
    expect((await as('quinn').send('POST', url, { targetMinor: 6000 })).statusCode).toBe(409);
    expect((await as('uma').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).statusCode).toBe(409);
    await ok(as('uma').send('PUT', `${url}/share`, { amountMinor: 2000 }));
    const g = (await as('robin').send('PUT', `${url}/share`, { amountMinor: 1500 })).json().gift.group;
    expect(g).toMatchObject({ totalMinor: 3500, myShareMinor: 1500, canManage: false, givers: [{ giver: { name: 'Uma' }, mine: false }, { giver: { name: 'Robin' }, mine: true }] });
    expect(JSON.stringify(g)).not.toContain('2000');
    expect((await as('robin').send('PATCH', url, { state: 'bought' })).statusCode).toBe(403);
    expect((await as('quinn').send('DELETE', url)).statusCode).toBe(409); // others chipped in
    expect((await as('quinn').send('PATCH', url, { targetMinor: 4000 })).json().gift.group.targetMinor).toBe(4000);
    await ok(as('quinn').send('PATCH', url, { state: 'bought' }));
    expect((await as('robin').send('DELETE', `${url}/share`)).statusCode).toBe(409);
    expect((await as('quinn').send('PATCH', url, { targetMinor: 5000 })).statusCode).toBe(409);
    expect((await as('quinn').send('PATCH', url, {})).statusCode).toBe(400);
    await ok(as('quinn').send('PATCH', url, { state: 'open' }));
    expect((await as('robin').send('DELETE', `${url}/share`)).statusCode).toBe(204);
    expect((await as('robin').send('DELETE', `${url}/share`)).statusCode).toBe(404);
  });
  it('not on a claimed wish; needs the household\'s currency; ends while nobody else is in', async () => {
    await ok(as('quinn').send('PUT', '/api/wishes/w_mia_bike/claim', { quantity: 1 }));
    expect((await as('uma').send('POST', '/api/wishes/w_mia_bike/group', { targetMinor: 100 })).statusCode).toBe(409);
    db.delete(t.setting).run();
    expect((await as('uma').send('POST', url, { targetMinor: 100 })).statusCode).toBe(409);
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    await ok(as('uma').send('POST', url, { targetMinor: 100 }));
    await ok(as('uma').send('PUT', `${url}/share`, { amountMinor: 100 }));
    expect((await as('uma').send('DELETE', url)).statusCode).toBe(204);
    expect(db.select().from(t.share).all().filter((s) => s.wishId === 'w_sam_book')).toEqual([]);
    expect((await as('uma').send('PUT', `${url}/share`, { amountMinor: 100 })).statusCode).toBe(404);
  });
  it('the organizer gone from the household: whoever chipped in runs it', async () => {
    await ok(as('quinn').send('POST', url, { targetMinor: 6000 }));
    await ok(as('uma').send('PUT', `${url}/share`, { amountMinor: 2000 }));
    db.delete(t.person).where(eq(t.person.id, 'p_quinn')).run();
    expect((await as('uma').send('PATCH', url, { state: 'bought' })).json().gift.group).toMatchObject({ organizer: null, state: 'bought', canManage: true });
    expect((await as('robin').send('PATCH', url, { state: 'open' })).statusCode).toBe(403);
  });
});

describe('no live updates', () => {
  it('there is no stream: no route answers text/event-stream or upgrades to a WebSocket', async () => {
    await fresh();
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const src = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(new URL(`${e.name}/`, d)) : [readFileSync(new URL(e.name, d), 'utf8')]));
    expect(src(dir).some((s) => /event-stream|websocket|\bupgrade\b/i.test(s))).toBe(false);
  });
});
