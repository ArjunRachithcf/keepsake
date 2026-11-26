// Claims and group gifts (spec §3) and ADR 0003's matrix on the raw responses (bodies and headers): every reading
// route × viewer (the person, a kid's parent, another adult, a kid, an admin, the givers) × wish state (claimed, bought,
// given, partly given, a group gift, after the occasion with and without a name, a celebration postponed or removed
// after the gift, the wish moved after it, the giver removed, a late gift). For whoever must not see gifts (the person,
// and kids), every answer is byte for byte the answer in a twin household with the same changes but no gifts at all,
// until the gift reaches its person (the day after the later of its occasion and the day it was given).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { today } from '../src/celebrations/dates';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshRevealed } from '../src/gifts/gifts';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';
import { countingTransport, withDevices } from './m4';

const PEOPLE = ['alex', 'sam', 'robin', 'mia', 'leo', 'quinn', 'uma'] as const;
type Who = (typeof PEOPLE)[number];
const NOW = '2026-11-01T10:00:00.000Z';
const TODAY = () => today(standalone().timezone);
/** The household's day `n` days from today. */
const D = (n: number) => new Date(Date.parse(`${TODAY()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// The clock stands still at one moment for every household of the file: both households of a comparison make their
// changes at the same time, so a time in an answer can only differ if a gift changed it.
const PINNED = new Date();
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(PINNED); });
afterAll(() => { vi.useRealTimers(); });

let built: BuiltApp | undefined;
let db: Db;
let cookies: Record<string, string>;
let pushes: Map<string, number>;

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
  pushes = withDevices(db);
  built = await buildApp(standalone(), db, { pushTransport: countingTransport(pushes) });
}
afterAll(() => built?.app.close());
/** A change made straight in the database (a test's time travel): what is received is rebuilt as after any change. */
const direct = (f: () => void) => { f(); refreshRevealed(db, TODAY()); };

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

// Every reading route. /household names Quinn and Uma by design, and /auth/session names the caller: the "never
// anywhere" checks leave those two out, the byte-for-byte comparison does not.
const READS = ['/api/notices', '/api/home', '/api/home?for=c_xmas', '/api/home?for=c_mia', '/api/home?for=any', '/api/celebrations',
  '/api/celebrations/c_xmas', '/api/celebrations/c_mia', '/api/auth/session', '/api/household', '/api/me/passkeys',
  ...['alex', 'sam', 'robin', 'mia', 'leo'].flatMap((p) => [`/api/people/p_${p}`, `/api/people/p_${p}?for=c_xmas`, `/api/people/p_${p}?for=any`])];
type Snap = { body: Record<string, string>; head: Record<string, string> };
/** Every reading answer, its headers without the one that changes by the second (`date`). */
async function reads(who: Who): Promise<Snap> {
  // The morning batch for this moment first (ADR 0010): notices, and the pushes they send, are read too.
  built!.morning(new Date());
  await built!.pusher.idle();
  const out: Snap = { body: { pushes: String(pushes.get(`p_${who}`) ?? 0) }, head: {} };
  for (const u of READS) {
    const r = await as(who).get(u);
    // A celebration removed in this state answers 404 for its page and 400 as a `for`, the same in both households.
    if (r.statusCode !== 404 && r.statusCode !== 400) expect(r.statusCode, `${who} ${u}: ${r.body}`).toBe(200);
    out.body[u] = r.body;
    out.head[u] = JSON.stringify(Object.entries(r.headers).filter(([k]) => k !== 'date').sort());
  }
  return out;
}

// What only givers may learn: the givers' ids and names, each share, the total and the target.
const GIVERS = ['p_quinn', 'Quinn', 'p_uma', 'Uma'];
const AMOUNTS = { quinn: '4321', uma: '1357', total: '5678', target: '9753' };

// Two wishes: an adult's (Sam's cookbook, for Christmas) and a kid's (Mia's bike, for her birthday).
const TARGETS = {
  w_sam_book: { person: 'sam' as Who, cel: 'c_xmas', givers: ['alex', 'robin', 'quinn', 'uma'] as Who[], shouldNot: ['sam', 'mia', 'leo'] as Who[] },
  w_mia_bike: { person: 'mia' as Who, cel: 'c_mia', givers: ['alex', 'sam', 'robin', 'quinn', 'uma'] as Who[], shouldNot: ['mia', 'leo'] as Who[] },
};
type Target = keyof typeof TARGETS;

const group = async (w: string) => {
  await ok(as('quinn').send('POST', `/api/wishes/${w}/group`, { targetMinor: Number(AMOUNTS.target) }));
  await ok(as('quinn').send('PUT', `/api/wishes/${w}/group/share`, { amountMinor: Number(AMOUNTS.quinn) }));
  await ok(as('uma').send('PUT', `/api/wishes/${w}/group/share`, { amountMinor: Number(AMOUNTS.uma) }));
};
const claim = async (w: string, state?: 'bought' | 'given', who: Who = 'quinn') => {
  await ok(as(who).send('PUT', `/api/wishes/${w}/claim`, { quantity: 1 }));
  if (state) await ok(as(who).send('PATCH', `/api/wishes/${w}/claim`, { state }));
};
const groupGiven = async (w: string) => { await group(w); await ok(as('quinn').send('PATCH', `/api/wishes/${w}/group`, { state: 'given' })); };
/**
 * Given `n` days ago (the database's given_on: time travel). `look`: whoever looks next sees today's state (a rebuild,
 * which also latches what is revealed); without it, the next change comes first, before anyone has looked.
 */
const givenAgo = (w: string, n: number, look = true) => {
  const f = () => {
    db.update(t.claim).set({ givenOn: D(-n) }).where(eq(t.claim.wishId, w)).run();
    db.update(t.groupGift).set({ givenOn: D(-n) }).where(eq(t.groupGift.wishId, w)).run();
  };
  if (look) direct(f); else f();
};
const dateOf = (cel: string, day: string) => ok(as('alex').send('PATCH', `/api/celebrations/${cel}`, { date: day }));
const moveTo = (w: string, cel: string | null) => ok(as('sam').send('PATCH', `/api/wishes/${w}`, { celebrationId: cel }));
const named = (w: string) => ok(as('quinn').send('PUT', `/api/wishes/${w}/named`, { named: true }));

interface State {
  /** Changes that are not gifts, made before the gifts, in both households. */
  pre?: (w: Target) => Promise<void>;
  /** The gifts (and their time travel), only in the household with gifts. */
  gifts: (w: Target) => Promise<void>;
  /** Changes that are not gifts, made after the gifts, in both households. */
  post?: (w: Target) => Promise<void>;
  /** Its person has it by today. */
  over: (w: Target) => boolean;
  named?: boolean; given?: boolean; group?: boolean; uma?: boolean; quinnGone?: boolean;
  /** Only gifts change (the write-route comparison runs on these). */
  pure?: boolean;
}
const yes = () => true, no = () => false;
const STATES: Record<string, State> = {
  claimed: { gifts: (w) => claim(w), over: no, pure: true },
  bought: { gifts: (w) => claim(w, 'bought'), over: no, pure: true },
  given: { gifts: (w) => claim(w, 'given'), over: no, given: true, pure: true },
  'partly given (2 wanted, 1 given, 1 claimed)': {
    pre: async (w) => { await ok(as('sam').send('PATCH', `/api/wishes/${w}`, { quantity: 2 })); },
    gifts: async (w) => { await claim(w, 'given'); await claim(w, undefined, 'uma'); }, over: no, uma: true,
  },
  'group gift with shares': { gifts: group, over: no, group: true, uma: true, pure: true },
  'group gift given': { gifts: groupGiven, over: no, given: true, group: true, uma: true, pure: true },
  'a late gift (given today, 5 days after the day)': { pre: (w) => dateOf(TARGETS[w].cel, D(-5)).then(), gifts: (w) => claim(w, 'given'), over: no, given: true },
  'after the occasion, no name': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-8)).then(), gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 10); }, over: yes, given: true,
  },
  'after the occasion, named': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-8)).then(), gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 10); await named(w); }, over: yes, named: true, given: true,
  },
  'group gift after the occasion, Quinn named': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-8)).then(), gifts: async (w) => { await groupGiven(w); givenAgo(w, 10); await named(w); }, over: yes, named: true, given: true, group: true, uma: true,
  },
  'the celebration postponed after the gift, before its day': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-3)).then(), gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 5, false); },
    post: (w) => dateOf(TARGETS[w].cel, D(10)).then(), over: no, given: true,
  },
  'the wish moved to a later celebration after the gift': {
    pre: async (w) => {
      direct(() => {
        db.insert(t.celebration).values({ id: 'c_soon', name: 'Garden day', date: D(-3), poster: 'gold', recurrence: 'yearly', hostId: 'p_alex', createdAt: NOW }).run();
        db.insert(t.celebrationPerson).values({ celebrationId: 'c_soon', personId: `p_${TARGETS[w].person}` }).run();
      });
      await moveTo(w, 'c_soon');
    },
    gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 5, false); },
    post: (w) => moveTo(w, TARGETS[w].cel).then(), over: no, given: true,
  },
  'the celebration removed after the gift': {
    gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 5, false); },
    post: (w) => ok(as('alex').send('DELETE', `/api/celebrations/${TARGETS[w].cel}`)).then(),
    // The occasion kept when it was given still holds: the reveal never moves earlier.
    over: no, given: true,
  },
  'the wish moved to any time after the gift (an earlier celebration in between)': {
    pre: () => Promise.resolve(direct(() => {
      db.insert(t.celebration).values({ id: 'c_dinner', name: 'Dinner', date: D(-2), poster: 'night', recurrence: 'yearly', hostId: 'p_alex', createdAt: NOW }).run();
      db.insert(t.celebrationPerson).values([{ celebrationId: 'c_dinner', personId: 'p_sam' }, { celebrationId: 'c_dinner', personId: 'p_mia' }]).run();
    })),
    gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 5, false); },
    post: (w) => moveTo(w, null).then(), over: no, given: true,
  },
  'revealed, then the date corrected later (it stays revealed)': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-8)).then(), gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 10); },
    post: (w) => dateOf(TARGETS[w].cel, D(5)).then(), over: yes, given: true,
  },
  'the giver removed (bought)': {
    gifts: (w) => claim(w, 'bought'), post: () => ok(as('alex').send('DELETE', '/api/people/p_quinn')).then(), over: no, quinnGone: true,
  },
  'the giver removed (only claimed: the claim goes with them)': {
    gifts: (w) => claim(w), post: () => ok(as('alex').send('DELETE', '/api/people/p_quinn')).then(), over: no, quinnGone: true,
  },
  'the giver removed after the occasion': {
    pre: (w) => dateOf(TARGETS[w].cel, D(-8)).then(), gifts: async (w) => { await claim(w, 'given'); givenAgo(w, 10); },
    post: () => ok(as('alex').send('DELETE', '/api/people/p_quinn')).then(), over: yes, given: true, quinnGone: true,
  },
};

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

/** The twin household: the same changes, no gifts. */
async function twin(target: Target, S: State) {
  await fresh();
  await S.pre?.(target);
  await S.post?.(target);
}
async function withGifts(target: Target, S: State) {
  await fresh();
  await S.pre?.(target);
  await S.gifts(target);
  await S.post?.(target);
}

describe.each(Object.keys(TARGETS) as Target[])('the surprise for %s (raw responses)', (target) => {
  const T = TARGETS[target];

  it("with no gifts, nobody's answers name a giver or an amount", async () => {
    await fresh();
    for (const who of PEOPLE) {
      const b = (await reads(who)).body;
      for (const g of [...GIVERS, ...Object.values(AMOUNTS)]) expect(without(b, '/api/auth/session', '/api/household').includes(g), `${who}: ${g}`).toBe(false);
    }
  });

  describe.each(Object.keys(STATES))('%s', (state) => {
    const S = STATES[state]!;
    it.each(PEOPLE)('as %s', async (who) => {
      if (S.quinnGone && who === 'quinn') return;
      const giver = T.givers.includes(who);
      const isOver = S.over(target);
      const twinSnap = !giver && !isOver ? (await twin(target, S), await reads(who)) : null;
      await withGifts(target, S);
      const snap = await reads(who);
      const body = snap.body;
      const all = without(body, '/api/household', '/api/auth/session');
      if (!giver) {
        // The person and kids: until the gift reaches its person, exactly the twin's answers, headers included.
        if (twinSnap) expect(snap).toEqual(twinSnap);
        else {
          const home = JSON.parse(body['/api/home']!) as { wishes: { id: string }[]; thanks: { wish: { id: string }; from: { name: string }[] }[] };
          // Received: gone from every list, the person's own included…
          expect(without(body, '/api/home').includes(target), `${who} still sees ${target}`).toBe(false);
          expect(home.wishes.map((w) => w.id)).not.toContain(target);
          // …and the thank-you (the kid's goes to the kid; Mia is no parent) names only who chose it.
          const thanks = home.thanks.filter((x) => x.wish.id === target);
          expect(thanks.length, `${who}'s thanks`).toBe(who === T.person ? 1 : 0);
          if (who === T.person) expect(thanks[0]!.from.map((p) => p.name)).toEqual(S.named ? ['Quinn'] : []);
        }
        // Never a share, a total, a target, Uma (never named), nor Quinn outside a thank-you she chose.
        for (const x of [...Object.values(AMOUNTS), 'p_uma', 'Uma']) expect(all.includes(x), `${who} sees ${x}`).toBe(false);
        expect(without(body, '/api/home', '/api/household', '/api/auth/session').includes('Quinn'), `${who} sees Quinn`).toBe(false);
        expect(body['/api/home']!.includes('Quinn'), `${who}'s home names Quinn`).toBe(who === T.person && Boolean(S.named) && !S.quinnGone);
        for (const b of Object.values(body)) for (const w of withId(b, target)) expect(w, `${who} gets ${target}'s gifts`).not.toHaveProperty('gift');
        return;
      }
      // Givers: until it is all given, they see it with its gifts; given, it is gone from their lists.
      const listed = without(body, '/api/home', '/api/auth/session', '/api/household').includes(target);
      expect(listed, `${who} lists ${target}`).toBe(!S.given);
      if (!S.given) {
        expect(all.includes('Quinn'), `${who} sees Quinn`).toBe(!S.quinnGone);
        expect(all.includes('Uma'), `${who} sees Uma`).toBe(Boolean(S.uma));
        if (S.group) {
          expect(all.includes(AMOUNTS.total) && all.includes(AMOUNTS.target), `${who} sees the total and target`).toBe(true);
          // Others' shares are names, not amounts: each giver sees their own only.
          expect(all.includes(AMOUNTS.quinn), `${who} sees Quinn's share`).toBe(who === 'quinn');
          expect(all.includes(AMOUNTS.uma), `${who} sees Uma's share`).toBe(who === 'uma');
        }
      }
      if (isOver && (who === 'quinn' || (S.group && who === 'uma'))) {
        const gave = JSON.parse(body['/api/home']!).gave as { wish: { id: string }; named: boolean }[];
        expect(gave.find((g) => g.wish.id === target)).toMatchObject({ named: who === 'quinn' && Boolean(S.named) });
      }
    });
  });

  it('the person\'s and a kid\'s answers to the gift routes and to their own changes are the same whatever the gifts are', async () => {
    const tries = [
      ['PUT', `/api/wishes/${target}/claim`, { quantity: 1 }], ['PATCH', `/api/wishes/${target}/claim`, { state: 'bought' }],
      ['DELETE', `/api/wishes/${target}/claim`], ['PUT', `/api/wishes/${target}/named`, { named: true }],
      ['POST', `/api/wishes/${target}/group`, { targetMinor: 100 }], ['PATCH', `/api/wishes/${target}/group`, { state: 'bought' }],
      ['DELETE', `/api/wishes/${target}/group`], ['PUT', `/api/wishes/${target}/group/share`, { amountMinor: 100 }],
      ['DELETE', `/api/wishes/${target}/group/share`],
    ] as const;
    // New ids differ between runs (they are random); nothing else may, times included (the clock is pinned).
    const norm = (r: { statusCode: number; body: string; headers: Record<string, unknown> }) => `${r.statusCode} ${JSON.stringify(Object.entries(r.headers).filter(([k]) => k !== 'date').sort())} ${
      r.body.replace(/"[0-9A-HJKMNP-TV-Z]{26}"/g, '"<id>"')}`;
    const answers = async () => {
      const out: string[] = [];
      for (const who of T.shouldNot) {
        for (const [m, u, b] of tries) {
          const r = await as(who).send(m, u, b);
          out.push(`${who} ${m} ${u} ${norm(r)}`);
          expect(r.statusCode, `${who} ${m} ${u}`).toBe(403);
        }
      }
      // The person changes the wish, adds one; an adult person hosts a celebration; a kid says yes to a suggestion.
      out.push(norm(await as(T.person).send('PATCH', `/api/wishes/${target}`, { note: 'Blue, please' })));
      out.push(norm(await as(T.person).send('POST', '/api/wishes', { personId: `p_${T.person}`, name: 'A torch', celebrationId: null })));
      if (T.person === 'sam') out.push(norm(await as('sam').send('POST', '/api/celebrations', { name: 'Picnic', date: '2027-06-01', poster: 'gold', recurrence: 'none', people: ['p_sam'] })));
      else out.push(norm(await as('mia').send('POST', '/api/wishes/w_sug_for_mia/approve')));
      return out;
    };
    await fresh();
    const none = await answers();
    for (const [state, S] of Object.entries(STATES)) {
      if (!S.pure) continue;
      await fresh();
      await S.gifts(target);
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
    // The occasion is the wish's, read now: moved, the claim follows.
    await moveTo('w_sam_book', null);
    expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/claim', { quantity: 1 })).json().gift.mine).toMatchObject({ celebrationId: 'c_xmas', forDate: '2026-12-24' });
    await moveTo('w_sam_book', 'c_xmas');
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

  it('moving a wish keeps its claims (ADR 0007); the reveal moves later with it, never earlier', async () => {
    await dateOf('c_xmas', D(-3));
    await claim('w_sam_book', 'given');
    givenAgo('w_sam_book', 5, false); // given before Christmas, which was 3 days ago; nobody has looked since
    // Moved to a celebration still to come before anyone looked: hidden until then.
    db.insert(t.celebration).values({ id: 'c_soon', name: 'Sam turns 40', date: D(20), poster: 'gold', recurrence: 'none', hostId: 'p_alex', createdAt: NOW }).run();
    db.insert(t.celebrationPerson).values({ celebrationId: 'c_soon', personId: 'p_sam' }).run();
    await moveTo('w_sam_book', 'c_soon');
    expect((await as('quinn').get('/api/people/p_sam')).json().wishes.map((w: { id: string }) => w.id)).not.toContain('w_sam_book');
    expect((await as('sam').get('/api/home')).json().wishes.map((w: { id: string }) => w.id)).toContain('w_sam_book');
    expect((await as('sam').get('/api/home')).json().thanks).toEqual([]);
    expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/named', { named: true })).statusCode).toBe(409);
    // Moved back to Christmas: the occasion kept when it was given (Christmas) is past, but the later one holds.
    await moveTo('w_sam_book', 'c_xmas');
    expect((await as('sam').get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id)).toEqual(['w_sam_book']);
  });

  it('once its person has it, it stays theirs: a date moved later does not hide it, and it cannot be un-given', async () => {
    await dateOf('c_xmas', D(-8));
    await claim('w_sam_book', 'given');
    givenAgo('w_sam_book', 10);
    expect((await as('sam').get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id)).toEqual(['w_sam_book']);
    await dateOf('c_xmas', D(5));
    const sam = (await as('sam').get('/api/home')).json();
    expect(sam.wishes.map((w: { id: string }) => w.id)).not.toContain('w_sam_book');
    expect(sam.thanks.map((x: { wish: { id: string } }) => x.wish.id)).toEqual(['w_sam_book']);
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'bought' })).statusCode).toBe(409);
    expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/named', { named: true })).statusCode).toBe(200);
  });

  it('a late gift for a one-off party counts for that party: its person learns it the next day', async () => {
    direct(() => {
      db.insert(t.celebration).values({ id: 'c_party', name: 'Party', date: D(-2), poster: 'berry', recurrence: 'none', hostId: 'p_alex', createdAt: NOW }).run();
      db.insert(t.celebrationPerson).values({ celebrationId: 'c_party', personId: 'p_sam' }).run();
      db.update(t.wish).set({ celebrationId: 'c_party' }).where(eq(t.wish.id, 'w_sam_book')).run();
    });
    // The party has passed: the wish is any time now (ADR 0007), and remembers the party.
    expect((await as('sam').get('/api/home')).json().wishes.find((w: { id: string }) => w.id === 'w_sam_book')).toMatchObject({ celebrationId: null });
    await claim('w_sam_book', 'given');
    expect((await as('sam').get('/api/home')).json().wishes.map((w: { id: string }) => w.id)).toContain('w_sam_book');
    givenAgo('w_sam_book', 1);
    expect((await as('sam').get('/api/home')).json().thanks).toMatchObject([{ wish: { id: 'w_sam_book' }, celebration: { id: 'c_party' } }]);
  });

  it('a late gift: its person learns it the next day, not the same day', async () => {
    await dateOf('c_xmas', D(-12));
    await claim('w_sam_book', 'given');
    expect((await as('sam').get('/api/home')).json().wishes.map((w: { id: string }) => w.id)).toContain('w_sam_book');
    expect((await as('quinn').send('PUT', '/api/wishes/w_sam_book/named', { named: true })).statusCode).toBe(409);
    givenAgo('w_sam_book', 1); // the next day
    expect((await as('sam').get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id)).toEqual(['w_sam_book']);
    expect((await as('quinn').get('/api/home')).json().gave[0]).toMatchObject({ wish: { id: 'w_sam_book', gift: { mine: { celebrationId: 'c_xmas', forDate: D(-12), over: true } } } });
    // Over: it stays given.
    expect((await as('quinn').send('PATCH', '/api/wishes/w_sam_book/claim', { state: 'claimed' })).statusCode).toBe(409);
  });

  it('a gift more than a month after a yearly day counts for the next one; an early one for the day ahead', async () => {
    await dateOf('c_xmas', D(-40));
    await claim('w_sam_book', 'given');
    const mine = (await as('quinn').send('PUT', '/api/wishes/w_sam_book/named', { named: true }));
    expect(mine.statusCode).toBe(409);
    expect((await as('sam').get('/api/home')).json().wishes.map((w: { id: string }) => w.id)).toContain('w_sam_book');
  });

  it('a removed giver: a claim only made goes, a bought or given one stays without a name', async () => {
    await claim('w_mia_bike'); // only claimed: goes with her
    await claim('w_alex_old', 'bought'); // bought: stays
    await ok(as('quinn').send('PUT', '/api/wishes/w_sam_pan/group/share', { amountMinor: 500 })); // an open group gift
    await dateOf('c_xmas', D(-8));
    await claim('w_sam_book', 'given');
    givenAgo('w_sam_book', 10);
    await named('w_sam_book');
    expect((await as('sam').get('/api/home')).json().thanks).toMatchObject([{ wish: { id: 'w_sam_book' }, from: [{ name: 'Quinn' }] }]);
    expect((await as('alex').send('DELETE', '/api/people/p_quinn')).statusCode).toBe(204);
    expect(db.select().from(t.claim).all().filter((c) => c.wishId !== 'w_robin_scarf').map((c) => [c.wishId, c.giverId, c.named]).sort())
      .toEqual([['w_alex_old', null, 0], ['w_sam_book', null, 0]]);
    expect(db.select().from(t.share).where(eq(t.share.wishId, 'w_sam_pan')).all()).toEqual([]); // an open group gift's share goes
    const sam = (await as('sam').get('/api/home')).json();
    expect(sam.wishes.map((w: { id: string }) => w.id)).not.toContain('w_sam_book');
    expect(sam.thanks).toMatchObject([{ wish: { id: 'w_sam_book' }, from: [] }]);
    // The bike is free again; the socks stay bought, by nobody named.
    expect((await as('robin').send('PUT', '/api/wishes/w_mia_bike/claim', { quantity: 1 })).statusCode).toBe(200);
    expect((await as('robin').get('/api/people/p_alex')).json().wishes.find((w: { id: string }) => w.id === 'w_alex_old').gift)
      .toMatchObject({ claimed: 1, left: 0, claims: [{ giver: null, state: 'bought', mine: false }] });
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
    await dateOf('c_mia', D(-8));
    await claim('w_mia_bike', 'given');
    const thanks = async (who: Who) => (await as(who).get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id);
    for (const who of ['mia', 'sam'] as const) expect(await thanks(who), `${who} before`).toEqual([]);
    givenAgo('w_mia_bike', 10);
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
    expect(g).toMatchObject({ totalMinor: 3500, myShareMinor: 1500, canManage: false });
    expect(g.givers).toEqual(expect.arrayContaining([{ giver: { id: 'p_uma', name: 'Uma' }, mine: false }, { giver: { id: 'p_robin', name: 'Robin' }, mine: true }]));
    expect(JSON.stringify(g)).not.toContain('2000');
    expect((await as('robin').send('PATCH', url, { state: 'bought' })).statusCode).toBe(403);
    expect((await as('quinn').send('DELETE', url)).statusCode).toBe(409); // others chipped in
    // All together up to the target: a share past it is refused, and so is a target below what is in.
    expect((await as('alex').send('PUT', `${url}/share`, { amountMinor: 2501 })).statusCode).toBe(409);
    expect((await as('quinn').send('PATCH', url, { targetMinor: 3499 })).statusCode).toBe(409);
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
