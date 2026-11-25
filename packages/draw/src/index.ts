// The draw ("draw names", ADR 0004) as pure functions: no I/O, no clock, no randomness of its own (the server passes a
// cryptographic source in). Every valid assignment is equally likely:
//
// - up to EXACT_MAX participants, by counting: the number of ways to finish from each set of receivers already taken
//   (a dynamic programme over subsets), then each giver's receiver chosen with the weight of the ways it leaves;
// - above that, by rejection: a uniformly random permutation (Fisher–Yates) until one keeps every rule.
//
// Both are exactly uniform given a uniform `random`. Before drawing, `feasible` says whether the rules may be drawn,
// and if not which rule blocks it (never who would draw whom). It decides from the participants and the exclusions
// only, never from last year's pairs (PR #10 review, M1):
//
// - at least MIN_PARTICIPANTS, and some assignment keeps the exclusions;
// - with "not last year's person" on, everyone keeps at least ⌈n/2⌉+1 people they may draw after the exclusions.
//   Taking last year's pairs away then costs each giver and each receiver at most one, which leaves every degree at
//   least n/2: by Hall's theorem a perfect matching always exists, so last year's pairs can never block (or shape) a
//   refusal;
// - nobody can work out anyone else's person (review H3): neither the host, from the rules alone, nor a giver, from
//   the rules and their own person. Exactly up to EXACT_MAX (no pair outside a giver's own is ever certain); above it,
//   a sufficient rule: everyone keeps at least ⌈n/2⌉+1 people they may draw.

/** A participant of a draw, by id only: the draw never sees names. */
export type ParticipantId = string;

/** The version of the draw's rules (stored with each draw). */
export const DRAW_RULES_VERSION = 1;

/** A draw needs at least four people: with three, whoever opens theirs knows the whole draw. */
export const MIN_PARTICIPANTS = 4;
export const MAX_PARTICIPANTS = 100;
/** Up to this many participants the draw counts its ways exactly (16! < 2^48, what `random` must cover). */
export const EXACT_MAX = 16;
/** Above EXACT_MAX: tries before the draw gives up on rules that leave too few ways (also bounded in time, DrawOptions). */
export const MAX_TRIES = 200_000;
/** The fewest people each participant must be allowed to draw, for the margin rules: ⌈n/2⌉+1. */
export const margin = (n: number) => Math.ceil(n / 2) + 1;

export interface Rules {
  /** Pairs who never draw each other, both ways. */
  exclusions?: readonly (readonly [ParticipantId, ParticipantId])[];
  /** "Not last year's person" is on: decides the margin rule, whether or not last year's pairs are known. */
  notLastYear?: boolean;
  /** Last year's giver → receiver, used only while drawing (never by `feasible`): nobody draws the same person again. */
  lastYear?: ReadonlyMap<ParticipantId, ParticipantId> | null;
}

/**
 * What blocks a draw: too few or too many people; the exclusions (with nobody drawing themselves); with "not last
 * year's person" on, exclusions that leave someone fewer than ⌈n/2⌉+1 people to draw; rules that let someone work out
 * another's person; or (above EXACT_MAX only) rules that leave so few ways that random tries do not find one in time.
 */
export type Blocker = 'too_few' | 'too_many' | 'exclusions' | 'last_year_margin' | 'guessable' | 'too_tight';
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

/** A perfect matching (owner[r] = g), or null. */
function matching(ok: boolean[][]): number[] | null {
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
  for (let g = 0; g < n; g++) if (!tryGiver(g, new Array<boolean>(n).fill(false))) return null;
  return owner;
}

/**
 * Which pairs occur in some perfect matching (null: there is none). A pair outside one matching M occurs in another iff
 * it lies on an M-alternating cycle: the giver and the receiver are in one strongly connected component of the graph
 * with giver → receiver for the other allowed pairs and receiver → its giver in M (Tarjan).
 */
function possiblePairs(ok: boolean[][]): boolean[][] | null {
  const n = ok.length;
  const owner = matching(ok);
  if (!owner) return null;
  // nodes: givers 0..n-1, receivers n..2n-1
  const next = (v: number): number[] => (v < n ? ok[v]!.flatMap((a, r) => (a && owner[r] !== v ? [n + r] : [])) : [owner[v - n]!]);
  const index = new Array<number>(2 * n).fill(-1), low = new Array<number>(2 * n).fill(0), comp = new Array<number>(2 * n).fill(-1);
  const stack: number[] = [], onStack = new Array<boolean>(2 * n).fill(false);
  let i = 0, c = 0;
  const visit = (v: number) => {
    index[v] = low[v] = i++; stack.push(v); onStack[v] = true;
    for (const w of next(v)) {
      if (index[w] === -1) { visit(w); low[v] = Math.min(low[v]!, low[w]!); } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) { let w: number; do { w = stack.pop()!; onStack[w] = false; comp[w] = c; } while (w !== v); c++; }
  };
  for (let v = 0; v < 2 * n; v++) if (index[v] === -1) visit(v);
  return ok.map((row, g) => row.map((a, r) => a && (owner[r] === g || comp[g] === comp[n + r])));
}

/**
 * Whether someone could work out another's person: the host from the rules (a pair that is certain), or a giver from
 * the rules and their own person (given g0 → r0, some other giver has one possible person left).
 */
function guessable(ok: boolean[][]): boolean {
  const n = ok.length;
  for (let g0 = 0; g0 < n; g0++) {
    for (let r0 = 0; r0 < n; r0++) {
      if (!ok[g0]![r0]) continue;
      const fixed = ok.map((row, g) => row.map((a, r) => a && (g === g0 ? r === r0 : r !== r0)));
      const pp = possiblePairs(fixed);
      if (!pp) continue; // g0 never draws r0: nothing to learn from it
      for (let g = 0; g < n; g++) if (g !== g0 && pp[g]!.filter(Boolean).length < 2) return true;
    }
  }
  return false;
}

/** Whether a draw may be made under these rules, and if not, which rule blocks it. Never looks at last year's pairs. */
export function feasible(ids: readonly ParticipantId[], rules: Rules = {}): Feasibility {
  if (ids.length < MIN_PARTICIPANTS) return { ok: false, rule: 'too_few' };
  if (ids.length > MAX_PARTICIPANTS) return { ok: false, rule: 'too_many' };
  const ok = allowedMatrix(ids, rules, false);
  if (!hasMatching(ok)) return { ok: false, rule: 'exclusions' };
  const fewest = Math.min(...ok.map((row) => row.filter(Boolean).length));
  if (rules.notLastYear && fewest < margin(ids.length)) return { ok: false, rule: 'last_year_margin' };
  if (ids.length <= EXACT_MAX ? guessable(ok) : fewest < margin(ids.length)) return { ok: false, rule: 'guessable' };
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

function byRejection(ok: boolean[][], random: Random, maxTries: number, deadline: (() => boolean) | undefined): number[] | null {
  const n = ok.length;
  for (let t = 0; t < maxTries; t++) {
    if (deadline && t % 256 === 0 && deadline()) return null;
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = checkedRandom(random, i + 1);
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    if (p.every((r, g) => ok[g]![r])) return p;
  }
  return null;
}

/**
 * Which method (by default counting up to EXACT_MAX, else rejection), and for rejection a bound: `maxTries`, and
 * `outOfTime`, asked every 256 tries (the server passes a clock: the draw stays a pure function of what it is given).
 */
export interface DrawOptions { method?: 'counting' | 'rejection'; maxTries?: number; outOfTime?: () => boolean }

/**
 * Draws names: each participant gets one receiver, nobody themselves, no excluded pair either way, and (when given)
 * nobody last year's person. Every valid assignment is equally likely. Throws DrawError naming the blocking rule.
 */
export function draw(ids: readonly ParticipantId[], rules: Rules, random: Random, o: DrawOptions = {}): Map<ParticipantId, ParticipantId> {
  const f = feasible(ids, rules);
  if (!f.ok) throw new DrawError(f.rule);
  if (rules.lastYear && !rules.notLastYear) throw new TypeError('draw: last year\'s pairs without notLastYear');
  const ok = allowedMatrix(ids, rules, true);
  // With the margin rule kept, last year's pairs never leave nobody a way (Hall); a check all the same.
  if (!hasMatching(ok)) throw new Error('draw: the margin rule did not hold');
  const method = o.method ?? (ids.length <= EXACT_MAX ? 'counting' : 'rejection');
  if (method === 'counting' && ids.length > EXACT_MAX) throw new RangeError(`draw: counting works up to ${EXACT_MAX} participants`);
  const picks = method === 'counting' ? byCounting(ok, random) : byRejection(ok, random, o.maxTries ?? MAX_TRIES, o.outOfTime);
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
