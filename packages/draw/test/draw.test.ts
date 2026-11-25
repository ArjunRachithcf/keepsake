// The draw (ADR 0004), exhaustively for small households and by properties for larger ones:
// - for 4 and 5 people, every set of exclusions with every "last year" (each valid assignment of the year before, or
//   none): `feasible` agrees with brute force (including "someone could work out another's person") and names the
//   right rule; it is the same whatever last year was (last year's pairs never block or shape a refusal); `ways`
//   counts exactly what brute force counts; and `draw` (both methods) keeps every rule and never fails once feasible;
// - uniformity: each valid assignment comes out about equally often (a chi-square test with a fixed seed, so the test
//   never flakes), by counting and by rejection;
// - larger households (up to 40, with random exclusions): valid whenever possible; node:crypto as the random source.
import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DRAW_RULES_VERSION, DrawError, EXACT_MAX, MIN_PARTICIPANTS, draw, feasible, isValid, margin, ways,
  type ParticipantId, type Random, type Rules,
} from '../src/index';

/** A seeded source (xorshift128+ over BigInt, 53-bit floats): the same numbers every run. */
function seeded(seed: number): Random {
  let s0 = BigInt(seed) * 0x9e3779b97f4a7c15n & 0xffffffffffffffffn | 1n;
  let s1 = (BigInt(seed) + 0x632be59bd9b4e019n) * 0xbf58476d1ce4e5b9n & 0xffffffffffffffffn | 1n;
  const M = 0xffffffffffffffffn;
  return (n) => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & M;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    const u = Number(((s1 + y) & M) >> 11n) / 2 ** 53;
    return Math.floor(u * n);
  };
}

const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
const asMap = (ids: string[], p: string[]) => new Map(ids.map((g, i) => [g, p[i]!]));
const PERMS = new Map<string, Map<string, string>[]>();
const allAssignments = (ids: string[]) => {
  const k = ids.join();
  if (!PERMS.has(k)) PERMS.set(k, permutations(ids).map((p) => asMap(ids, p)));
  return PERMS.get(k)!;
};
/** Every valid assignment, by brute force. */
const valid = (ids: string[], rules: Rules) => allAssignments(ids).filter((a) => {
  const ex = new Set((rules.exclusions ?? []).flatMap(([a1, b]) => [`${a1}>${b}`, `${b}>${a1}`]));
  return [...a].every(([g, r]) => g !== r && !ex.has(`${g}>${r}`) && rules.lastYear?.get(g) !== r);
});
const pairsOf = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const));
const subsets = <T>(xs: readonly T[]) => Array.from({ length: 2 ** xs.length }, (_, m) => xs.filter((_x, i) => m & (1 << i)));
const key = (a: ReadonlyMap<string, string>) => [...a].map(([g, r]) => `${g}>${r}`).join(',');
/** Brute force: could the host (from the rules) or a giver (from the rules and their own person) work out a pair? */
function bruteGuessable(ids: string[], all: Map<string, string>[]): boolean {
  for (const a of all) {
    for (const g0 of ids) {
      const same = all.filter((b) => b.get(g0) === a.get(g0));
      for (const g of ids) if (g !== g0 && new Set(same.map((b) => b.get(g))).size === 1) return true;
    }
  }
  return false;
}
/** What feasible() must say, by brute force, from the exclusions alone. */
function expected(ids: string[], exclusions: (readonly [string, string])[], notLastYear: boolean) {
  if (ids.length < MIN_PARTICIPANTS) return { ok: false, rule: 'too_few' };
  if (notLastYear && ids.length < 5) return { ok: false, rule: 'too_few_last_year' };
  const all = valid(ids, { exclusions });
  if (!all.length) return { ok: false, rule: 'exclusions' };
  const fewest = Math.min(...ids.map((g) => ids.filter((r) => r !== g && !exclusions.some(([a, b]) => (a === g && b === r) || (a === r && b === g))).length));
  if (notLastYear && fewest < margin(ids.length)) return { ok: false, rule: 'last_year_margin' };
  if (bruteGuessable(ids, all)) return { ok: false, rule: 'guessable' };
  return { ok: true };
}

describe('@keepsake/draw', () => {
  it('is version 1 of the rules', () => expect(DRAW_RULES_VERSION).toBe(1));

  it.each([0, 1, 2, 3])('%i people are too few (with 3, whoever opens theirs knows the whole draw)', (n) => {
    expect(feasible(people(n))).toEqual({ ok: false, rule: 'too_few' });
    expect(() => draw(people(n), {}, seeded(1))).toThrow(DrawError);
  });
  it('101 people are too many', () => expect(feasible(people(101))).toEqual({ ok: false, rule: 'too_many' }));
  it('refuses a participant twice and an exclusion with a stranger (programming errors, not rules)', () => {
    expect(() => feasible(['a', 'b', 'c', 'a'])).toThrow(TypeError);
    expect(() => feasible(['a', 'b', 'c', 'd'], { exclusions: [['a', 'z']] })).toThrow(TypeError);
  });

  it('with not last year\'s person on, four are too few: knowing last year, one\'s own pair would tell the rest (second review H4)', () => {
    const ids = people(4);
    expect(feasible(ids, { notLastYear: true })).toEqual({ ok: false, rule: 'too_few_last_year' });
    // brute force: after every possible last year, this year's draws are guessable to whoever knows last year
    for (const last of valid(ids, {})) expect(bruteGuessable(ids, valid(ids, { notLastYear: true, lastYear: last }))).toBe(true);
    // with five, after no last year are they
    const five = people(5);
    expect(feasible(five, { notLastYear: true })).toEqual({ ok: true });
    for (const last of valid(five, {})) expect(bruteGuessable(five, valid(five, { notLastYear: true, lastYear: last })), key(last)).toBe(false);
  });

  describe('rules that let someone work out another\'s person (review H3)', () => {
    it('two couples among four: whoever draws, their partner\'s person is certain', () => {
      expect(feasible(people(4), { exclusions: [['p0', 'p1'], ['p2', 'p3']] })).toEqual({ ok: false, rule: 'guessable' });
    });
    it('a host who leaves one way only', () => {
      const exclusions = [['p0', 'p1'], ['p0', 'p2'], ['p3', 'p1'], ['p3', 'p2']] as const;
      expect(ways(people(4), { exclusions: [...exclusions] })).toBe(1);
      expect(feasible(people(4), { exclusions: [...exclusions] })).toEqual({ ok: false, rule: 'guessable' });
    });
    it('four with no rules, five with a couple, six with two, eight with four couples: fine', () => {
      expect(feasible(people(4))).toEqual({ ok: true });
      expect(feasible(people(5), { exclusions: [['p0', 'p1']] })).toEqual({ ok: true });
      expect(feasible(people(6), { exclusions: [['p0', 'p1'], ['p2', 'p3']] })).toEqual({ ok: true });
      expect(feasible(people(8), { exclusions: [['p0', 'p1'], ['p2', 'p3'], ['p4', 'p5'], ['p6', 'p7']] })).toEqual({ ok: true });
    });
    it(`above ${EXACT_MAX}: everyone keeps at least ⌈n/2⌉+1 people to draw`, () => {
      const ids = people(20);
      const many = ids.slice(1, 10).map((r) => ['p0', r] as const); // p0 may draw 10 others: under 11
      expect(feasible(ids, { exclusions: many })).toEqual({ ok: false, rule: 'guessable' });
      expect(feasible(ids, { exclusions: many.slice(1) })).toEqual({ ok: true });
    });
  });

  describe.each([4, 5])('every rule set for %i people (exhaustive)', (n) => {
    const ids = people(n);
    const lastYears = valid(ids, {});
    const exclusionSets = subsets(pairsOf(ids));
    it(`${exclusionSets.length} exclusion sets × (${lastYears.length} last years, none, and the rule off)`, () => {
      let cases = 0;
      for (const exclusions of exclusionSets) {
        // the rule off: the exclusions decide
        const off = feasible(ids, { exclusions });
        expect(off).toEqual(expected(ids, exclusions, false));
        // the rule on: the same answer whatever last year was, or with no last year at all
        const on = feasible(ids, { exclusions, notLastYear: true });
        expect(on).toEqual(expected(ids, exclusions, true));
        expect(ways(ids, { exclusions })).toBe(valid(ids, { exclusions }).length);
        for (const lastYear of lastYears) {
          const rules: Rules = { exclusions, notLastYear: true, lastYear };
          expect(feasible(ids, rules)).toEqual(on);
          const all = valid(ids, rules);
          expect(ways(ids, rules)).toBe(all.length);
          for (const method of ['counting', 'rejection'] as const) {
            if (!on.ok) { expect(() => draw(ids, rules, seeded(cases), { method })).toThrow(expect.objectContaining({ rule: (on as { rule: string }).rule })); continue; }
            // once feasible, never refused: last year's pairs cannot block it (Hall)
            const a = draw(ids, rules, seeded(cases), { method });
            expect(isValid(ids, rules, a)).toBe(true);
            expect(all.map(key)).toContain(key(a));
          }
          cases++;
        }
        if (off.ok) {
          const a = draw(ids, { exclusions }, seeded(cases));
          expect(isValid(ids, { exclusions }, a)).toBe(true);
        }
      }
      expect(cases).toBe(exclusionSets.length * lastYears.length);
    }, 300_000);
  });

  it('six people: a sample of exclusion sets agrees with brute force', () => {
    const ids = people(6);
    const random = seeded(6);
    const pairs = pairsOf(ids);
    for (let t = 0; t < 150; t++) {
      const exclusions = pairs.filter(() => random(100) < 25);
      expect(feasible(ids, { exclusions }), JSON.stringify(exclusions)).toEqual(expected(ids, exclusions, false));
    }
  }, 120_000);

  describe('every valid assignment equally likely (chi-square, fixed seeds)', () => {
    // df = ways - 1; the 0.1 % critical values: a uniform draw fails these about once in a thousand seeds, and these
    // seeds are fixed, so the test never flakes.
    const CRITICAL: Record<number, number> = { 1: 10.83, 8: 26.12, 10: 29.59, 12: 32.91, 43: 77.42 };
    const cases: [string, string[], Rules][] = [
      ['4 people, no rules (9 ways)', people(4), {}],
      ['5 people, no rules (44 ways)', people(5), {}],
      ['5 people, a couple apart (2 exclusions)', people(5), { exclusions: [['p0', 'p1'], ['p2', 'p3']] }],
      ['5 people, not last year', people(5), { notLastYear: true, lastYear: new Map([['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4'], ['p4', 'p0']]) }],
      ['6 people, two couples and last year', people(6), { exclusions: [['p0', 'p1'], ['p2', 'p3']], notLastYear: true, lastYear: new Map([['p0', 'p2'], ['p2', 'p4'], ['p4', 'p0'], ['p1', 'p3'], ['p3', 'p5'], ['p5', 'p1']]) }],
    ];
    it.each(cases.flatMap(([name, ids, rules]) => (['counting', 'rejection'] as const).map((m) => [`${name}, ${m}`, ids, rules, m] as const)))('%s', (_n, ids, rules, method) => {
      const all = valid(ids, rules).map(key);
      const k = all.length;
      const df = k - 1;
      const critical = CRITICAL[df] ?? df + 4 * Math.sqrt(2 * df); // a generous bound for other sizes
      const perWay = 300;
      const counts = new Map(all.map((x) => [x, 0]));
      const random = seeded(k * 7919);
      for (let i = 0; i < k * perWay; i++) {
        const x = key(draw(ids, rules, random, { method }));
        counts.set(x, counts.get(x)! + 1);
      }
      expect(counts.size).toBe(k); // nothing outside the valid set
      const chi = [...counts.values()].reduce((s, c) => s + (c - perWay) ** 2 / perWay, 0);
      expect(chi, `chi-square ${chi.toFixed(1)} on ${df} degrees of freedom`).toBeLessThan(critical);
      expect(Math.min(...counts.values())).toBeGreaterThan(0);
    });

    it('each giver gets each other person about equally often (12 people, no rules)', () => {
      const ids = people(12);
      const random = seeded(12);
      const n = 1500;
      const m = new Map<string, number>();
      for (let i = 0; i < n; i++) for (const [g, r] of draw(ids, {}, random)) m.set(`${g}>${r}`, (m.get(`${g}>${r}`) ?? 0) + 1);
      // each giver has 11 possible people: 1500/11 ≈ 136 each
      for (const [, c] of m) expect(Math.abs(c - n / 11)).toBeLessThan(5 * Math.sqrt(n / 11));
      expect(m.size).toBe(12 * 11);
    }, 60_000);
  });

  describe('larger households (properties)', () => {
    it('valid whenever possible, with random exclusions, up to 40 people; next year never refused once feasible', () => {
      const random = seeded(40);
      let drawn = 0;
      for (let t = 0; t < 300; t++) {
        const n = MIN_PARTICIPANTS + random(37);
        const ids = people(n);
        const exclusions = pairsOf(ids).filter(() => random(100) < 6);
        const rules: Rules = { exclusions };
        const f = feasible(ids, rules);
        if (!f.ok) { expect(['exclusions', 'guessable']).toContain(f.rule); continue; }
        const a = draw(ids, rules, random);
        expect(isValid(ids, rules, a)).toBe(true);
        drawn++;
        const next: Rules = { exclusions, notLastYear: true, lastYear: a };
        const g = feasible(ids, next);
        if (g.ok) expect(isValid(ids, next, draw(ids, next, random))).toBe(true);
        else expect(['last_year_margin', 'too_few_last_year']).toContain(g.rule);
      }
      expect(drawn).toBeGreaterThan(100);
    });

    it(`counts exactly up to ${EXACT_MAX} people: the derangement numbers`, () => {
      const D = [1, 0, 1, 2, 9, 44, 265, 1854, 14833, 133496, 1334961, 14684570, 176214841, 2290792932, 32071101049, 481066515734, 7697064251745];
      for (let n = 0; n <= EXACT_MAX; n++) expect(ways(people(n))).toBe(D[n]);
      expect(() => ways(people(EXACT_MAX + 1))).toThrow(RangeError);
    });

    it(`${EXACT_MAX} people with couples: the exact check, then counting`, () => {
      const ids = people(EXACT_MAX);
      const exclusions = ids.filter((_, i) => i % 2 === 0).map((a, i) => [a, ids[2 * i + 1]!] as const);
      const rules = { exclusions, notLastYear: true, lastYear: new Map(ids.map((g, i) => [g, ids[(i + 2) % ids.length]!])) };
      expect(feasible(ids, rules)).toEqual({ ok: true });
      expect(isValid(ids, rules, draw(ids, rules, seeded(16)))).toBe(true);
    });

    it('gives up in time or tries, naming that', () => {
      const ids = people(EXACT_MAX + 1);
      expect(feasible(ids)).toEqual({ ok: true });
      expect(() => draw(ids, {}, seeded(3), { maxTries: 0 })).toThrow(expect.objectContaining({ rule: 'too_tight' }));
      expect(() => draw(ids, {}, () => 0, { outOfTime: () => true })).toThrow(expect.objectContaining({ rule: 'too_tight' }));
    });

    it('works with node:crypto as its random source, and refuses a broken one', () => {
      const ids = people(8);
      expect(isValid(ids, {}, draw(ids, {}, (n) => randomInt(n)))).toBe(true);
      expect(isValid(people(30), {}, draw(people(30), {}, (n) => randomInt(n)))).toBe(true);
      expect(() => draw(ids, {}, () => 1.5)).toThrow(RangeError);
      expect(() => draw(ids, {}, (n) => n)).toThrow(RangeError);
    });

    it('a participant not in last year\'s draw, or last year\'s person who is not here now, constrains nothing', () => {
      const ids: ParticipantId[] = ['a', 'b', 'c', 'd'];
      const lastYear = new Map([['a', 'z'], ['y', 'b']]);
      expect(ways(ids, { notLastYear: true, lastYear })).toBe(9);
    });
  });
});
