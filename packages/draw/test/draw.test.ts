// The draw (ADR 0004), exhaustively for small households and by properties for larger ones:
// - for 3, 4 and 5 people, every set of exclusions with every "last year" (each valid assignment of the year before, or
//   none): `feasible` agrees with brute force and names the right rule, `ways` counts exactly what brute force counts,
//   and `draw` (both methods) returns an assignment that keeps every rule;
// - uniformity: each valid assignment comes out about equally often (a chi-square test with a fixed seed, so the test
//   never flakes), by counting and by rejection;
// - larger households (up to 40, with random exclusions): valid whenever possible; node:crypto as the random source.
import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DRAW_RULES_VERSION, DrawError, EXACT_MAX, MIN_PARTICIPANTS, draw, feasible, isValid, ways,
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

describe('@keepsake/draw', () => {
  it('is version 1 of the rules', () => expect(DRAW_RULES_VERSION).toBe(1));

  it.each([0, 1, 2])('%i people are too few', (n) => {
    expect(feasible(people(n))).toEqual({ ok: false, rule: 'too_few' });
    expect(() => draw(people(n), {}, seeded(1))).toThrow(DrawError);
  });
  it('101 people are too many', () => expect(feasible(people(101))).toEqual({ ok: false, rule: 'too_many' }));
  it('refuses a participant twice and an exclusion with a stranger (programming errors, not rules)', () => {
    expect(() => feasible(['a', 'b', 'a'])).toThrow(TypeError);
    expect(() => feasible(['a', 'b', 'c'], { exclusions: [['a', 'z']] })).toThrow(TypeError);
  });

  describe.each([3, 4, 5])('every rule set for %i people (exhaustive)', (n) => {
    const ids = people(n);
    const lastYears: (Map<string, string> | null)[] = [null, ...valid(ids, {})];
    const exclusionSets = subsets(pairsOf(ids));
    it(`${exclusionSets.length} exclusion sets × ${lastYears.length} last years`, () => {
      let cases = 0;
      for (const exclusions of exclusionSets) {
        const withoutLast = valid(ids, { exclusions }).length;
        for (const lastYear of lastYears) {
          const rules: Rules = { exclusions, lastYear };
          const all = valid(ids, rules);
          // feasible() agrees with brute force and blames the right rule
          const f = feasible(ids, rules);
          if (all.length) expect(f).toEqual({ ok: true });
          else expect(f).toEqual({ ok: false, rule: withoutLast === 0 ? 'exclusions' : 'last_year' });
          // ways() counts exactly
          expect(ways(ids, rules)).toBe(all.length);
          // draw() keeps every rule (both methods), or refuses naming the rule
          for (const method of ['counting', 'rejection'] as const) {
            if (!all.length) {
              expect(() => draw(ids, rules, seeded(cases), { method })).toThrow(expect.objectContaining({ rule: (f as { rule: string }).rule }));
              continue;
            }
            const a = draw(ids, rules, seeded(cases), { method });
            expect(isValid(ids, rules, a)).toBe(true);
            expect(all.map(key)).toContain(key(a));
          }
          cases++;
        }
      }
      expect(cases).toBe(exclusionSets.length * lastYears.length);
    }, 120_000);
  });

  describe('every valid assignment equally likely (chi-square, fixed seeds)', () => {
    // df = ways - 1; the 0.1 % critical values: a uniform draw fails these about once in a thousand seeds, and these
    // seeds are fixed, so the test never flakes.
    const CRITICAL: Record<number, number> = { 1: 10.83, 8: 26.12, 10: 29.59, 12: 32.91, 43: 77.42 };
    const cases: [string, string[], Rules][] = [
      ['4 people, no rules (9 ways)', people(4), {}],
      ['5 people, no rules (44 ways)', people(5), {}],
      ['5 people, a couple apart (2 exclusions)', people(5), { exclusions: [['p0', 'p1'], ['p2', 'p3']] }],
      ['5 people, not last year', people(5), { lastYear: new Map([['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4'], ['p4', 'p0']]) }],
      ['6 people, two couples and last year', people(6), { exclusions: [['p0', 'p1'], ['p2', 'p3']], lastYear: new Map([['p0', 'p2'], ['p2', 'p4'], ['p4', 'p0'], ['p1', 'p3'], ['p3', 'p5'], ['p5', 'p1']]) }],
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
      const n = 6000;
      const m = new Map<string, number>();
      for (let i = 0; i < n; i++) for (const [g, r] of draw(ids, {}, random)) m.set(`${g}>${r}`, (m.get(`${g}>${r}`) ?? 0) + 1);
      // each giver has 11 possible people: 6000/11 ≈ 545 each
      for (const [, c] of m) expect(Math.abs(c - n / 11)).toBeLessThan(5 * Math.sqrt(n / 11));
      expect(m.size).toBe(12 * 11);
    });
  });

  describe('larger households (properties)', () => {
    it('valid whenever possible, with random exclusions, up to 40 people', () => {
      const random = seeded(40);
      for (let t = 0; t < 300; t++) {
        const n = MIN_PARTICIPANTS + random(38);
        const ids = people(n);
        const exclusions = pairsOf(ids).filter(() => random(100) < 15);
        const rules: Rules = { exclusions };
        const f = feasible(ids, rules);
        if (!f.ok) { expect(f.rule).toBe('exclusions'); continue; }
        const a = draw(ids, rules, random);
        expect(isValid(ids, rules, a)).toBe(true);
        // and next year, not this year's person
        const next = { exclusions, lastYear: a };
        if (feasible(ids, next).ok) expect(isValid(ids, next, draw(ids, next, random))).toBe(true);
      }
    });

    it(`counts exactly up to ${EXACT_MAX} people: the derangement numbers`, () => {
      const D = [1, 0, 1, 2, 9, 44, 265, 1854, 14833, 133496, 1334961, 14684570, 176214841, 2290792932, 32071101049, 481066515734, 7697064251745];
      for (let n = 0; n <= EXACT_MAX; n++) expect(ways(people(n))).toBe(D[n]);
      expect(() => ways(people(EXACT_MAX + 1))).toThrow(RangeError);
    });

    it(`a ring that is nearly the only way left is found by counting (${EXACT_MAX} people)`, () => {
      // Everyone may draw only a neighbour one or two places away, and not the one two places on (last year's).
      for (const n of [EXACT_MAX]) {
        const ids = people(n);
        const lastYear = new Map(ids.map((g, i) => [g, ids[(i + 2) % n]!]));
        const exclusions = pairsOf(ids).filter(([a, b]) => {
          const d = (ids.indexOf(b) - ids.indexOf(a) + n) % n;
          return d !== 1 && d !== n - 1 && d !== 2 && d !== n - 2;
        });
        const rules = { exclusions, lastYear };
        if (n <= EXACT_MAX) expect(ways(ids, rules)).toBeGreaterThan(0);
        expect(isValid(ids, rules, draw(ids, rules, seeded(n)))).toBe(true);
      }
    });

    it('gives up on rules too tight for random tries, naming that', () => {
      const ids = people(EXACT_MAX + 4);
      // the only ways left: everyone draws the next person (one ring), or close to it
      const exclusions = pairsOf(ids).filter(([a, b]) => Math.abs(ids.indexOf(a) - ids.indexOf(b)) % (ids.length - 1) !== 1);
      const rules = { exclusions };
      expect(feasible(ids, rules)).toEqual({ ok: true });
      expect(() => draw(ids, rules, seeded(3), { maxTries: 50 })).toThrow(expect.objectContaining({ rule: 'too_tight' }));
    });

    it('works with node:crypto as its random source, and refuses a broken one', () => {
      const ids = people(8);
      expect(isValid(ids, {}, draw(ids, {}, (n) => randomInt(n)))).toBe(true);
      expect(isValid(ids, {}, draw(people(30), {}, (n) => randomInt(n)) && draw(ids, {}, (n) => randomInt(n)))).toBe(true);
      expect(() => draw(ids, {}, () => 1.5)).toThrow(RangeError);
      expect(() => draw(ids, {}, (n) => n)).toThrow(RangeError);
    });

    it('a participant not in last year\'s draw, or last year\'s person who is not here now, constrains nothing', () => {
      const ids: ParticipantId[] = ['a', 'b', 'c'];
      const lastYear = new Map([['a', 'z'], ['y', 'b']]);
      expect(ways(ids, { lastYear })).toBe(2);
    });
  });
});
