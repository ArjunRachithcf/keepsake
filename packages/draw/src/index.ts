// The draw ("draw names", ADR 0004) as pure functions: no I/O, no clock, no randomness of its own (the server passes a
// cryptographic source in). Every valid assignment is equally likely:
//
// - up to EXACT_MAX participants, by counting: the number of ways to finish from each set of receivers already taken
//   (a dynamic programme over subsets), then each giver's receiver chosen with the weight of the ways it leaves;
// - above that, by rejection: a uniformly random permutation (Fisher–Yates) until one keeps every rule.
//
// Both are exactly uniform given a uniform `random`. Before drawing, `feasible` says whether any assignment keeps the
// rules, and if not which rule blocks it (never who would draw whom).

/** A participant of a draw, by id only: the draw never sees names. */
export type ParticipantId = string;

/** The version of the draw's rules (stored with each draw). */
export const DRAW_RULES_VERSION = 1;

/** A draw needs at least three people: with two, each would know who drew them. */
export const MIN_PARTICIPANTS = 3;
export const MAX_PARTICIPANTS = 100;
/** Up to this many participants the draw counts its ways exactly (16! < 2^48, what `random` must cover). */
export const EXACT_MAX = 16;
/** Above EXACT_MAX: tries before the draw gives up on rules that leave too few ways. */
export const MAX_TRIES = 200_000;

export interface Rules {
  /** Pairs who never draw each other, both ways. */
  exclusions?: readonly (readonly [ParticipantId, ParticipantId])[];
  /** Last year's giver → receiver: when set, nobody draws the same person again. */
  lastYear?: ReadonlyMap<ParticipantId, ParticipantId> | null;
}

/**
 * What blocks a draw: too few or too many people, the exclusions (with nobody drawing themselves), "not last year's
 * person" on top of them, or (above EXACT_MAX only) rules that leave so few ways that random tries do not find one.
 */
export type Blocker = 'too_few' | 'too_many' | 'exclusions' | 'last_year' | 'too_tight';
export type Feasibility = { ok: true } | { ok: false; rule: Blocker };

export class DrawError extends Error {
  constructor(readonly rule: Blocker) { super(`the draw is not possible: ${rule}`); }
}

/** A uniform whole number in [0, n), for n up to 2^48 (node:crypto's randomInt). */
export type Random = (n: number) => number;

/** Who may draw whom under `rules`, by index into `ids`: never oneself, never an excluded pair, never last year's. */
function allowedMatrix(ids: readonly ParticipantId[], rules: Rules, withLastYear: boolean): boolean[][] {
  const at = new Map(ids.map((id, i) => [id, i]));
  if (at.size !== ids.length) throw new TypeError('draw: a participant appears twice');
  const ok = ids.map((_, g) => ids.map((__, r) => g !== r));
  for (const [a, b] of rules.exclusions ?? []) {
    const i = at.get(a), j = at.get(b);
    if (i === undefined || j === undefined) throw new TypeError('draw: an exclusion names someone who is not in the draw');
    ok[i]![j] = false;
    ok[j]![i] = false;
  }
  if (withLastYear && rules.lastYear) {
    for (const [g, r] of rules.lastYear) {
      const i = at.get(g), j = at.get(r);
      // Someone who was not in it last year, or whose person is not in it this year, has nothing to avoid.
      if (i !== undefined && j !== undefined) ok[i]![j] = false;
    }
  }
  return ok;
}

/** Whether every giver can get a different receiver (a perfect matching; Kuhn's augmenting paths). */
function hasMatching(ok: boolean[][]): boolean {
  const n = ok.length;
  const owner = new Array<number>(n).fill(-1);
  const tryGiver = (g: number, seen: boolean[]): boolean => {
    for (let r = 0; r < n; r++) {
      if (!ok[g]![r] || seen[r]) continue;
      seen[r] = true;
      if (owner[r] === -1 || tryGiver(owner[r]!, seen)) { owner[r] = g; return true; }
    }
    return false;
  };
  for (let g = 0; g < n; g++) if (!tryGiver(g, new Array<boolean>(n).fill(false))) return false;
  return true;
}

/** Whether a draw is possible, and if not, which rule blocks it. */
export function feasible(ids: readonly ParticipantId[], rules: Rules = {}): Feasibility {
  if (ids.length < MIN_PARTICIPANTS) return { ok: false, rule: 'too_few' };
  if (ids.length > MAX_PARTICIPANTS) return { ok: false, rule: 'too_many' };
  if (!hasMatching(allowedMatrix(ids, rules, false))) return { ok: false, rule: 'exclusions' };
  if (rules.lastYear && !hasMatching(allowedMatrix(ids, rules, true))) return { ok: false, rule: 'last_year' };
  return { ok: true };
}

/** For each set of receivers taken by the first popcount(mask) givers, the ways to finish (exact up to EXACT_MAX). */
function waysTable(ok: boolean[][]): Float64Array {
  const n = ok.length;
  const full = (1 << n) - 1;
  const w = new Float64Array(1 << n);
  w[full] = 1;
  for (let mask = full - 1; mask >= 0; mask--) {
    let k = 0;
    for (let m = mask; m; m &= m - 1) k++;
    let sum = 0;
    for (let r = 0; r < n; r++) if (!(mask & (1 << r)) && ok[k]![r]) sum += w[mask | (1 << r)]!;
    w[mask] = sum;
  }
  return w;
}

/** How many assignments keep the rules (EXACT_MAX participants at most; for tests and sanity checks). */
export function ways(ids: readonly ParticipantId[], rules: Rules = {}): number {
  if (ids.length > EXACT_MAX) throw new RangeError(`draw: ways() counts up to ${EXACT_MAX} participants`);
  if (ids.length === 0) return 1;
  return waysTable(allowedMatrix(ids, rules, true))[0]!;
}

function checkedRandom(random: Random, n: number): number {
  const x = random(n);
  if (!Number.isInteger(x) || x < 0 || x >= n) throw new RangeError('draw: random(n) must be a whole number in [0, n)');
  return x;
}

function byCounting(ok: boolean[][], random: Random): number[] {
  const n = ok.length;
  const w = waysTable(ok);
  const out: number[] = [];
  let mask = 0;
  for (let g = 0; g < n; g++) {
    let x = checkedRandom(random, w[mask]!);
    let pick = -1;
    for (let r = 0; r < n; r++) {
      if (mask & (1 << r) || !ok[g]![r]) continue;
      const v = w[mask | (1 << r)]!;
      if (x < v) { pick = r; break; }
      x -= v;
    }
    out.push(pick);
    mask |= 1 << pick;
  }
  return out;
}

function byRejection(ok: boolean[][], random: Random, maxTries: number): number[] | null {
  const n = ok.length;
  for (let t = 0; t < maxTries; t++) {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = checkedRandom(random, i + 1);
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    if (p.every((r, g) => ok[g]![r])) return p;
  }
  return null;
}

/** Options for tests: which method to use (by default counting up to EXACT_MAX, else rejection). */
export interface DrawOptions { method?: 'counting' | 'rejection'; maxTries?: number }

/**
 * Draws names: each participant gets one receiver, nobody themselves, no excluded pair either way, and (when given)
 * nobody last year's person. Every valid assignment is equally likely. Throws DrawError naming the blocking rule.
 */
export function draw(ids: readonly ParticipantId[], rules: Rules, random: Random, o: DrawOptions = {}): Map<ParticipantId, ParticipantId> {
  const f = feasible(ids, rules);
  if (!f.ok) throw new DrawError(f.rule);
  const ok = allowedMatrix(ids, rules, true);
  const method = o.method ?? (ids.length <= EXACT_MAX ? 'counting' : 'rejection');
  if (method === 'counting' && ids.length > EXACT_MAX) throw new RangeError(`draw: counting works up to ${EXACT_MAX} participants`);
  const picks = method === 'counting' ? byCounting(ok, random) : byRejection(ok, random, o.maxTries ?? MAX_TRIES);
  if (!picks) throw new DrawError('too_tight');
  const out = new Map(picks.map((r, g) => [ids[g]!, ids[r]!]));
  // A last check of the result itself, whatever the method did.
  if (!isValid(ids, rules, out)) throw new Error('draw: an assignment broke the rules');
  return out;
}

/** Whether an assignment keeps the rules and gives everyone exactly one giver (for tests and as a last check). */
export function isValid(ids: readonly ParticipantId[], rules: Rules, a: ReadonlyMap<ParticipantId, ParticipantId>): boolean {
  if (a.size !== ids.length) return false;
  const ok = allowedMatrix(ids, rules, true);
  const at = new Map(ids.map((id, i) => [id, i]));
  const received = new Set<ParticipantId>();
  for (const [g, r] of a) {
    const i = at.get(g), j = at.get(r);
    if (i === undefined || j === undefined || !ok[i]![j] || received.has(r)) return false;
    received.add(r);
  }
  return true;
}
