// Draws (spec §3, ADR 0004): a celebration's "draw names", one per celebration and year, run by its host (or, when it
// has none, an admin). The pairs come from @keepsake/draw with node:crypto's randomInt and are sealed per giver
// (draws/sealed.ts) in the same transaction that replaces the old ones. Nothing here returns a pair to a route:
//
// - `openOwn` opens the caller's own row, only once they have opened their draw (the view layer asks);
// - `openAll` opens every row, for the view layer after the host's reveal date, and for the draw itself when
//   "not last year's person" needs last year's pairs (nothing of them leaves but the new draw's yes or no);
// - refusals name a rule (which one blocks the draw), never a pair; the audit names who did what to which draw.
//
// Rules: participants are the celebration's people (kids only with "Kids draw too"); exclusions are the host's to set
// and see, both ways; draw together is a time before which nobody opens theirs; the reveal is a day after the
// celebration, or never (the default). Re-draw (and any change of who draws or the rules once drawn): freely until
// someone has opened theirs; after that, only before the celebration's day, never once a participant has marked a gift
// bought for another (the caller's own wishes left out: their gifts are not theirs to learn), and everyone opens
// theirs again (`redrawn_at`). Once the celebration's day has come, only the reveal date changes.
import { randomBytes } from 'node:crypto';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import { DrawError, draw as drawNames, feasible, type Blocker, type Rules } from '@keepsake/draw';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { Refused, type Message } from '../errors';
import { canChange, mustGetCelebration, peopleOf, type Celebration } from '../celebrations/celebrations';
import { daysBetween, nextDate, onYear } from '../celebrations/dates';
import { currency, getPerson, type Person } from '../household/people';
import { today as dayIn } from '../celebrations/dates';
import { keyId, openRow, sealReceiver, type Keyring } from './sealed';

export type Draw = typeof t.draw.$inferSelect;
export type Participant = typeof t.drawParticipant.$inferSelect;

export interface DrawInput {
  /** Who draws: the celebration's people (kids only with kidsDraw). */
  people: string[];
  /** Pairs of those people who never draw each other. */
  exclusions: [string, string][];
  kidsDraw: boolean;
  notLastYear: boolean;
  budgetMinor: number | null;
  drawTogetherAt: string | null;
  revealOn: string | null;
}
const RULE_FIELDS = ['people', 'exclusions', 'kidsDraw', 'notLastYear'] as const;

/** Tries to draw (drawn, re-drawn or refused) per celebration and year, in a day: bounds the work a host can ask for. */
export const RUNS_A_DAY = 20;
/** How long one draw may search (rejection above 16 people) before it is refused as too tight. */
export const DRAW_BUDGET_MS = 300;
export const MAX_EXCLUSIONS = 200;

const ts = () => new Date().toISOString();

// --- Reading -----------------------------------------------------------------------------------------------------

/** The year of the celebration's next day on or after `today`: the year a new draw is for. */
export const drawYear = (c: Celebration, today: string) => Number(nextDate(c.date, c.recurrence, today).slice(0, 4));
/** The celebration's day in the draw's year, as the celebration is now. */
export const dayOf = (c: Pick<Celebration, 'date' | 'recurrence'>, year: number) => (c.recurrence === 'yearly' ? onYear(c.date, year) : c.date);
/**
 * The draw's day: the later of the celebration's day now and the day it was drawn for (`occasion_on`), so it only ever
 * moves later (review H2).
 */
export const occasionOf = (c: Pick<Celebration, 'date' | 'recurrence'>, d: Pick<Draw, 'year' | 'occasionOn'>) => {
  const now = dayOf(c, d.year);
  return d.occasionOn && d.occasionOn > now ? d.occasionOn : now;
};
/** Its day has come: from then on only the reveal date changes. */
export const dayHasCome = (c: Celebration, d: Draw, today: string) => today >= occasionOf(c, d);
/**
 * Every pair is shown to the participants (and the host) from the reveal date on, and never before the day after the
 * celebration; once shown, for good (`revealed_at`).
 */
export const isRevealed = (c: Celebration, d: Draw, today: string) => d.revealedAt !== null || (d.drawnAt !== null && d.revealOn !== null && today >= d.revealOn && today > occasionOf(c, d));
/** isRevealed, latched the first time it holds. */
export function revealedNow(db: Db, c: Celebration, d: Draw, today: string): boolean {
  if (!isRevealed(c, d, today)) return false;
  if (!d.revealedAt) db.update(t.draw).set({ revealedAt: today }).where(eq(t.draw.id, d.id)).run();
  return true;
}
/** Whether a giver may open theirs now. */
export const opensNow = (d: Draw, now: Date) => d.drawnAt !== null && (d.drawTogetherAt === null || now.getTime() >= Date.parse(d.drawTogetherAt));

/**
 * The host runs the draw; a celebration whose host has left, or whose host is now a kid, an admin. Never a kid.
 * `hostRole`: the host's role now (null when there is none).
 */
export const managesDraw = (me: Pick<Person, 'id' | 'role'>, c: Pick<Celebration, 'hostId'>, hostRole: Person['role'] | null) =>
  me.role !== 'kid' && (c.hostId && hostRole && hostRole !== 'kid' ? c.hostId === me.id : me.role === 'admin');
export const hostRoleOf = (db: Db, c: Pick<Celebration, 'hostId'>) => (c.hostId ? getPerson(db, c.hostId)?.role ?? null : null);

/** The celebration's latest draw (this year's, or the last one). */
export function latestDraw(db: Db, celebrationId: string): Draw | undefined {
  return db.select().from(t.draw).where(eq(t.draw.celebrationId, celebrationId)).all().sort((a, b) => b.year - a.year)[0];
}
/** Every celebration's latest draw, at once (for the view layer's celebration lists). */
export function latestDraws(db: Db): Map<string, Draw> {
  const m = new Map<string, Draw>();
  for (const d of db.select().from(t.draw).all()) if ((m.get(d.celebrationId)?.year ?? -Infinity) < d.year) m.set(d.celebrationId, d);
  return m;
}
function mustDraw(db: Db, celebrationId: string): { c: Celebration; d: Draw } {
  const c = mustGetCelebration(db, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  return { c, d };
}
export function participantsOf(db: Db, drawIds: string[]): Participant[] {
  return drawIds.length ? db.select().from(t.drawParticipant).where(inArray(t.drawParticipant.drawId, drawIds)).all() : [];
}
export function exclusionsOf(db: Db, drawId: string): { a: string; b: string }[] {
  return db.select({ a: t.drawExclusion.a, b: t.drawExclusion.b }).from(t.drawExclusion).where(eq(t.drawExclusion.drawId, drawId)).all();
}

/**
 * The caller's own receiver (a participant id) once they have opened their draw: null when they have not (or have no
 * row), 'unreadable' when their row does not open with the keys here (only their own answer says so).
 */
export function openOwn(db: Db, ring: Keyring, d: Draw, me: Participant): string | 'unreadable' | null {
  if (!me.openedAt || me.drawId !== d.id) return null;
  const row = db.select().from(t.drawAssignment).where(and(eq(t.drawAssignment.drawId, d.id), eq(t.drawAssignment.giverId, me.id))).get();
  return row ? openRow(ring, d.id, row) ?? 'unreadable' : null;
}

/**
 * Every giver → receiver (participant ids; null for a row that does not open). Only after the reveal (the view layer)
 * or inside a new draw (last year's pairs).
 */
export function openAll(db: Db, ring: Keyring, d: Draw): Map<string, string | null> {
  return new Map(db.select().from(t.drawAssignment).where(eq(t.drawAssignment.drawId, d.id)).all().map((row) => [row.giverId, openRow(ring, d.id, row)]));
}

// --- Changing ----------------------------------------------------------------------------------------------------

function audit(db: Db, actorId: string, action: (typeof t.AUDIT_ACTIONS)[number], drawId: string) {
  db.insert(t.audit).values({ id: ulid(), at: ts(), actorId, action, subjectId: drawId }).run();
}

function managing(db: Db, me: Person, celebrationId: string): Celebration {
  const c = mustGetCelebration(db, celebrationId);
  if (!managesDraw(me, c, hostRoleOf(db, c))) throw new Refused(403, 'only the celebration\'s host runs its draw');
  return c;
}

/** The input checked against the celebration and the household; returns it with duplicates gone. */
function checked(db: Db, c: Celebration, i: DrawInput, d: Pick<Draw, 'year' | 'occasionOn'> & { id?: string; drawnAt?: string | null }): DrawInput {
  const inCelebration = new Set(peopleOf(db, c.id));
  // Someone in a drawn draw who has since become a kid stays in it until its day ("Kids draw too" decides who joins a
  // draw, not who leaves one already drawn; ADR 0004).
  const already = new Set(d.id && d.drawnAt ? participantsOf(db, [d.id]).map((p) => p.personId) : []);
  const people = [...new Set(i.people)];
  for (const id of people) {
    const p = getPerson(db, id);
    if (!p || !inCelebration.has(id)) throw new Refused(400, 'people: someone is not in the celebration');
    if (p.role === 'kid' && !i.kidsDraw && !already.has(id)) throw new Refused(400, 'people: a kid draws only when kids draw too');
  }
  const seen = new Set<string>();
  const exclusions: [string, string][] = [];
  for (const [a, b] of i.exclusions) {
    if (a === b || !people.includes(a) || !people.includes(b)) throw new Refused(400, 'exclusions: two different people of the draw each');
    const k = [a, b].sort().join();
    if (!seen.has(k)) { seen.add(k); exclusions.push([a, b]); }
  }
  if (exclusions.length > MAX_EXCLUSIONS) throw Refused.field('exclusions', 'up to # pairs of two ids', MAX_EXCLUSIONS);
  if (i.budgetMinor !== null && !currency(db)) throw new Refused(409, 'the household has no currency yet: an admin sets it first');
  if (i.revealOn !== null && i.revealOn <= occasionOf(c, d)) throw new Refused(400, 'revealOn: a day after the celebration, or never');
  return { ...i, people, exclusions };
}

/** Writes the draw's people and exclusions (participant ids kept for whoever stays). */
function writeRules(db: Db, drawId: string, i: DrawInput): void {
  const now = ts();
  const existing = participantsOf(db, [drawId]);
  const byPerson = new Map(existing.map((p) => [p.personId, p]));
  for (const p of existing) if (p.kind === 'person' && !i.people.includes(p.personId!)) db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, p.id)).run();
  for (const id of i.people) {
    if (!byPerson.has(id)) {
      const row = { id: ulid(), drawId, kind: 'person' as const, personId: id, createdAt: now };
      db.insert(t.drawParticipant).values(row).run();
      byPerson.set(id, { ...row, guestId: null, openedAt: null });
    }
  }
  db.delete(t.drawExclusion).where(eq(t.drawExclusion.drawId, drawId)).run();
  for (const [x, y] of i.exclusions) {
    const [a, b] = [byPerson.get(x)!.id, byPerson.get(y)!.id].sort() as [string, string];
    db.insert(t.drawExclusion).values({ drawId, a, b }).run();
  }
}

const settings = (i: DrawInput) => ({
  budgetMinor: i.budgetMinor, kidsDraw: i.kidsDraw ? 1 : 0, notLastYear: i.notLastYear ? 1 : 0,
  drawTogetherAt: i.drawTogetherAt, revealOn: i.revealOn,
});

/** A new draw for the celebration's next day (by its host). Returns the celebration's id. */
export function createDraw(db: Db, me: Person, celebrationId: string, i: DrawInput, today: string): string {
  const c = managing(db, me, celebrationId);
  const year = drawYear(c, today);
  const d0 = { year, occasionOn: null };
  if (today >= occasionOf(c, d0)) throw new Refused(409, 'its day has come: the draw stays as it is');
  if (db.select({ id: t.draw.id }).from(t.draw).where(and(eq(t.draw.celebrationId, c.id), eq(t.draw.year, year))).get()) {
    throw new Refused(409, 'this celebration has a draw already');
  }
  // A one-off moved into the next year must not let a new draw take the place of one whose names are drawn.
  const latest = latestDraw(db, c.id);
  if (latest?.drawnAt && !dayHasCome(c, latest, today)) throw new Refused(409, 'this celebration has a draw already');
  const input = checked(db, c, i, d0);
  const id = ulid();
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    tx.insert(t.draw).values({ id, celebrationId: c.id, year, rulesVersion: 1, ...settings(input), createdBy: me.id, createdAt: ts(), updatedAt: ts() }).run();
    writeRules(tx, id, input);
    audit(tx, me.id, 'draw_created', id);
  });
  return c.id;
}

/** The draw as the host set it, as input (to merge a change into). */
function inputOf(db: Db, d: Draw): DrawInput {
  const ps = participantsOf(db, [d.id]);
  const person = new Map(ps.map((p) => [p.id, p.personId!]));
  return {
    people: ps.filter((p) => p.kind === 'person').map((p) => p.personId!),
    exclusions: exclusionsOf(db, d.id).map((e) => [person.get(e.a)!, person.get(e.b)!]),
    kidsDraw: d.kidsDraw === 1, notLastYear: d.notLastYear === 1, budgetMinor: d.budgetMinor,
    drawTogetherAt: d.drawTogetherAt, revealOn: d.revealOn,
  };
}

/**
 * Since the names were drawn, has a participant marked a gift bought (or given) for another participant, for this
 * celebration or any time? Gifts from before the draw have nothing to do with it. The caller's own wishes are left
 * out: whether someone bought them something is not theirs to learn (ADR 0003).
 */
function giftBought(db: Db, c: Celebration, d: Draw, caller: string): boolean {
  const ps = participantsOf(db, [d.id]);
  const persons = ps.filter((p) => p.kind === 'person').map((p) => p.personId!);
  // Guests in the draw (M4) give too; they have no wishes of their own.
  const guests = ps.filter((p) => p.kind === 'guest').map((p) => p.guestId!);
  const others = persons.filter((p) => p !== caller);
  if (!others.length) return false;
  const wishes = db.select({ id: t.wish.id }).from(t.wish).where(and(inArray(t.wish.personId, others), eq(t.wish.state, 'listed'),
    or(eq(t.wish.celebrationId, c.id), isNull(t.wish.celebrationId)))).all().map((w) => w.id);
  if (!wishes.length) return false;
  const since = d.drawnAt!;
  const byGiver = guests.length ? or(inArray(t.claim.giverId, persons), inArray(t.claim.guestId, guests)) : inArray(t.claim.giverId, persons);
  const claim = db.select({ id: t.claim.id }).from(t.claim).where(and(inArray(t.claim.wishId, wishes), byGiver,
    inArray(t.claim.state, ['bought', 'given']), gte(t.claim.updatedAt, since))).get();
  if (claim) return true;
  const groups = db.select({ id: t.groupGift.wishId }).from(t.groupGift).where(and(inArray(t.groupGift.wishId, wishes),
    inArray(t.groupGift.state, ['bought', 'given']), gte(t.groupGift.updatedAt, since))).all().map((g) => g.id);
  return groups.length > 0 && Boolean(db.select({ id: t.share.id }).from(t.share).where(and(inArray(t.share.wishId, groups), inArray(t.share.giverId, persons))).get());
}

const anyOpened = (db: Db, d: Draw) => participantsOf(db, [d.id]).some((p) => p.openedAt !== null);

/** Who draws whom may change now (a first draw, a re-draw, new rules once drawn, removing the draw)? Refuses if not. */
function mayChangePairs(db: Db, me: Person, c: Celebration, d: Draw, today: string): void {
  if (dayHasCome(c, d, today)) throw new Refused(409, 'its day has come: the draw stays as it is');
  if (d.drawnAt && anyOpened(db, d) && giftBought(db, c, d, me.id)) throw new Refused(409, 'a gift is bought already: the draw stays as it is');
}

/** Whether the host could re-draw now (for the view: the button), with the same checks as a re-draw. */
export function canRedraw(db: Db, me: Person, c: Celebration, d: Draw, today: string): boolean {
  if (!managesDraw(me, c, hostRoleOf(db, c))) return false;
  try { mayChangePairs(db, me, c, d, today); return true; } catch { return false; }
}

const BLOCKED: Record<Blocker, Message> = {
  too_few: 'a draw needs at least 4 people',
  too_few_last_year: 'with not last year\'s person on, a draw needs at least 5 people',
  too_many: 'a draw holds at most 100 people',
  exclusions: 'who shouldn\'t draw whom leaves someone nobody to draw: loosen it',
  last_year_margin: 'with not last year\'s person on, everyone needs more people they may draw: loosen who shouldn\'t draw whom',
  guessable: 'these rules let someone work out another\'s person: add people or loosen who shouldn\'t draw whom',
  too_tight: 'the rules leave too few ways to draw in time: loosen who shouldn\'t draw whom',
};

/**
 * Last year's pairs in this draw's participant ids (by person), for "not last year's person". Used only while drawing:
 * whether a draw may be made never depends on them (the margin rule, @keepsake/draw). A row that does not open adds
 * no constraint.
 */
function lastYearOf(db: Db, ring: Keyring, d: Draw, ps: Participant[]): Map<string, string> | null {
  if (!d.notLastYear) return null;
  const last = db.select().from(t.draw).where(and(eq(t.draw.celebrationId, d.celebrationId), eq(t.draw.year, d.year - 1))).get();
  if (!last?.drawnAt) return null;
  const lastPs = participantsOf(db, [last.id]).filter((p) => p.kind === 'person');
  const personOf = new Map(lastPs.map((p) => [p.id, p.personId]));
  // Only the household's people: a guest's link is for one year's draw.
  const nowOf = new Map(ps.filter((p) => p.kind === 'person').map((p) => [p.personId, p.id]));
  const out = new Map<string, string>();
  for (const [g, r] of openAll(db, ring, last)) {
    if (!r) continue;
    const a = nowOf.get(personOf.get(g) ?? null), b = nowOf.get(personOf.get(r) ?? null);
    if (a && b) out.set(a, b);
  }
  return out;
}

/** Seals each giver's receiver in place of the old rows, in the givers' order (so the order says nothing). */
export function sealAssignments(db: Db, key: Buffer, drawId: string, pairs: ReadonlyMap<string, string>): void {
  db.delete(t.drawAssignment).where(eq(t.drawAssignment.drawId, drawId)).run();
  const id = keyId(key);
  for (const g of [...pairs.keys()].sort()) {
    db.insert(t.drawAssignment).values({ drawId, giverId: g, sealed: sealReceiver(key, drawId, g, pairs.get(g)!), keyId: id }).run();
  }
}

/** Tries in the last 24 hours for the celebration and year (whatever draw ids came and went). */
function runsToday(db: Db, d: Draw): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return db.select({ id: t.drawTry.id }).from(t.drawTry).where(and(eq(t.drawTry.celebrationId, d.celebrationId), eq(t.drawTry.year, d.year), gte(t.drawTry.at, since))).all().length;
}

/**
 * A uniform whole number in [0, n) from node:crypto, for n up to 2^48: 48-bit values from a pool of random bytes,
 * rejected above the largest multiple of n (so no value is likelier than another). Faster than randomInt per call.
 */
function cryptoRandom(): (n: number) => number {
  let pool = Buffer.alloc(0), at = 0;
  const next48 = () => {
    if (at + 6 > pool.length) { pool = randomBytes(6 * 1024); at = 0; }
    const v = pool.readUIntBE(at, 6);
    at += 6;
    return v;
  };
  return (n) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 2 ** 48) throw new RangeError('cryptoRandom: n out of range');
    const limit = 2 ** 48 - (2 ** 48 % n);
    for (;;) { const v = next48(); if (v < limit) return v % n; }
  };
}

/** The new pairs under the rules as they are in the database now, or the rule that blocks them. */
function prepare(db: Db, d: Draw, ring: Keyring): { pairs: Map<string, string> } | { blocked: Blocker } {
  // Everyone in it: the household's people and the guests who joined by a personal link (M4), under the same rules.
  const ps = participantsOf(db, [d.id]).sort((a, b) => a.id.localeCompare(b.id));
  const ids = ps.map((p) => p.id);
  const exclusions = exclusionsOf(db, d.id).map((e) => [e.a, e.b] as const);
  // Feasibility from the participants and the exclusions alone; last year's pairs only once it is decided.
  const f = feasible(ids, { exclusions, notLastYear: d.notLastYear === 1 });
  if (!f.ok) return { blocked: f.rule };
  const rules: Rules = { exclusions, notLastYear: d.notLastYear === 1, lastYear: lastYearOf(db, ring, d, ps) };
  const until = Date.now() + DRAW_BUDGET_MS;
  try { return { pairs: drawNames(ids, rules, cryptoRandom(), { outOfTime: () => Date.now() > until }) }; } catch (e) { if (e instanceof DrawError) return { blocked: e.rule }; throw e; }
}

/**
 * Seals the new pairs in place of the old ones; after someone had opened theirs, everyone opens theirs again. Run in
 * the caller's transaction.
 */
function commit(db: Db, me: Person, d: Draw, key: Buffer, pairs: Map<string, string>): void {
  const again = d.drawnAt !== null;
  const told = again && anyOpened(db, d);
  sealAssignments(db, key, d.id, pairs);
  const c = mustGetCelebration(db, d.celebrationId);
  db.update(t.draw).set({ drawnAt: ts(), redrawnAt: told ? ts() : d.redrawnAt, occasionOn: occasionOf(c, d), updatedAt: ts() }).where(eq(t.draw.id, d.id)).run();
  if (told) db.update(t.drawParticipant).set({ openedAt: null }).where(eq(t.drawParticipant.drawId, d.id)).run();
  audit(db, me.id, again ? 'redrawn' : 'drawn', d.id);
}

/** A refused try: audited (outside any transaction that is rolled back), then refused naming the rule. */
function refuse(db: Db, me: Person, d: Draw, rule: Blocker): never {
  audit(db, me.id, 'draw_refused', d.id);
  throw new Refused(409, BLOCKED[rule]);
}
/** Counts a try (whatever comes of it), or refuses one beyond RUNS_A_DAY. */
const often = (db: Db, d: Draw) => {
  if (runsToday(db, d) >= RUNS_A_DAY) throw new Refused(409, 'the names were drawn often today: try again tomorrow');
  db.insert(t.drawTry).values({ id: ulid(), celebrationId: d.celebrationId, year: d.year, at: ts() }).run();
};
class Blocked { constructor(readonly rule: Blocker) {} }

const needKey = (ring: Keyring | null): Buffer => {
  if (!ring?.current) throw new Refused(409, 'draws need the sealing key on the server (KEEPSAKE_SEALING_KEY)');
  return ring.current;
};

/** Draw (or re-draw) the names. Returns the celebration's id. */
export function runDraw(db: Db, me: Person, celebrationId: string, today: string, ring: Keyring): string {
  const c = managing(db, me, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  mayChangePairs(db, me, c, d, today);
  // Kids only with "Kids draw too", as roles are now; someone who became a kid after the draw was made stays (ADR 0004).
  if (!d.drawnAt && !d.kidsDraw && participantsOf(db, [d.id]).some((p) => p.personId && getPerson(db, p.personId)?.role === 'kid')) {
    throw new Refused(400, 'people: a kid draws only when kids draw too');
  }
  const k = needKey(ring);
  often(db, d);
  const p = prepare(db, d, ring);
  if ('blocked' in p) refuse(db, me, d, p.blocked);
  db.transaction((tx) => commit(asDb(tx), me, d, k, p.pairs));
  return c.id;
}

/**
 * Changes the draw. Once its day has come only the reveal date changes. Once drawn, a change to who draws or the rules
 * draws the names again, under the re-draw rules. Returns the celebration's id.
 */
export function editDraw(db: Db, me: Person, celebrationId: string, patch: Partial<DrawInput>, today: string, ring: Keyring): string {
  const c = managing(db, me, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  const before = inputOf(db, d);
  const next = checked(db, c, { ...before, ...patch }, d);
  const same = (k: keyof DrawInput) => JSON.stringify(k === 'people' ? [...next.people].sort() : k === 'exclusions' ? next.exclusions.map((e) => [...e].sort().join()).sort() : next[k])
    === JSON.stringify(k === 'people' ? [...before.people].sort() : k === 'exclusions' ? before.exclusions.map((e) => [...e].sort().join()).sort() : before[k]);
  const rulesChange = RULE_FIELDS.some((k) => !same(k));
  const otherChange = (['budgetMinor', 'drawTogetherAt'] as const).some((k) => !same(k));
  if (dayHasCome(c, d, today) && (rulesChange || otherChange)) throw new Refused(409, 'its day has come: the draw stays as it is');
  if (!same('revealOn') && isRevealed(c, d, today)) throw new Refused(409, 'it is revealed: it stays revealed');
  if (rulesChange && d.drawnAt) mayChangePairs(db, me, c, d, today);
  const k = rulesChange && d.drawnAt ? needKey(ring) : null;
  if (k) often(db, d);
  try {
    db.transaction((tx0) => {
      const tx = asDb(tx0);
      tx.update(t.draw).set({ ...settings(next), updatedAt: ts() }).where(eq(t.draw.id, d.id)).run();
      if (rulesChange) { veil(tx, d, today); writeRules(tx, d.id, next); }
      audit(tx, me.id, 'draw_changed', d.id);
      if (!same('revealOn')) audit(tx, me.id, 'reveal_set', d.id);
      if (!k) return;
      // Drawn again under the new rules in the same transaction: a refusal leaves the rules as they were.
      const p = prepare(tx, d, ring);
      if ('blocked' in p) throw new Blocked(p.blocked);
      commit(tx, me, d, k, p.pairs);
    });
  } catch (e) {
    if (e instanceof Blocked) refuse(db, me, d, e.rule);
    throw e;
  }
  return c.id;
}

/** Removes the draw, when who draws whom may still change. */
export function removeDraw(db: Db, me: Person, celebrationId: string, today: string): void {
  const c = managing(db, me, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  mayChangePairs(db, me, c, d, today);
  db.transaction((tx) => {
    veilGoing(asDb(tx), d, today);
    tx.delete(t.draw).where(eq(t.draw.id, d.id)).run();
    // Its guests' links go with it (their participant rows cascade).
    tx.update(t.guestLink).set({ revokedAt: ts() }).where(and(eq(t.guestLink.celebrationId, c.id), eq(t.guestLink.kind, 'draw'), isNull(t.guestLink.revokedAt))).run();
    audit(asDb(tx), me.id, 'draw_removed', d.id);
  });
}

// --- Guests (M4, ADR 0009) -----------------------------------------------------------------------------------------

/** Guests one draw may hold (the participants all together stay within the draw's 100). */
export const MAX_GUESTS = 50;

/**
 * The host invites a guest by a personal link: `makeLink` writes the link (in this transaction) and returns its id, and
 * the guest joins the draw as a participant of kind guest. Once the names are drawn, that is a re-draw under the
 * re-draw rules (in the same transaction: a refusal leaves no link and no participant). Returns the celebration's id.
 */
export function addGuest(db: Db, me: Person, celebrationId: string, makeLink: (tx: Db) => string, today: string, ring: Keyring): string {
  const c = managing(db, me, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  if (dayHasCome(c, d, today)) throw new Refused(409, 'its day has come: the draw stays as it is');
  if (participantsOf(db, [d.id]).filter((p) => p.kind === 'guest').length >= MAX_GUESTS) throw new Refused(409, 'a draw holds at most 50 guests');
  if (d.drawnAt) mayChangePairs(db, me, c, d, today);
  const k = d.drawnAt ? needKey(ring) : null;
  if (k) often(db, d);
  try {
    db.transaction((tx0) => {
      const tx = asDb(tx0);
      const linkId = makeLink(tx);
      tx.insert(t.drawParticipant).values({ id: ulid(), drawId: d.id, kind: 'guest', guestId: linkId, createdAt: ts() }).run();
      audit(tx, me.id, 'draw_changed', d.id);
      if (!k) return;
      const p = prepare(tx, d, ring);
      if ('blocked' in p) throw new Blocked(p.blocked);
      commit(tx, me, d, k, p.pairs);
    });
  } catch (e) {
    if (e instanceof Blocked) refuse(db, me, d, e.rule);
    throw e;
  }
  return c.id;
}

/** A guest's place in their celebration's draw (the latest one), if any. */
export function guestPlace(db: Db, linkId: string): { c: Celebration; d: Draw; me: Participant } | null {
  const me = db.select().from(t.drawParticipant).where(and(eq(t.drawParticipant.kind, 'guest'), eq(t.drawParticipant.guestId, linkId))).get();
  const d = me ? db.select().from(t.draw).where(eq(t.draw.id, me.drawId)).get() : undefined;
  return me && d ? { c: mustGetCelebration(db, d.celebrationId), d, me } : null;
}

/** A revoked guest leaves a draw whose names are not drawn yet; once drawn, they stay in it (their link just stops). */
export function guestLeaves(db: Db, linkId: string): void {
  const place = guestPlace(db, linkId);
  if (place && !place.d.drawnAt) db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, place.me.id)).run();
}

/** A guest opens theirs (after the draw-together time). */
export function openDrawAsGuest(db: Db, linkId: string, now: Date, ring: Keyring): void {
  const place = guestPlace(db, linkId);
  if (!place) throw new Refused(404, 'this celebration has no draw');
  if (!place.d.drawnAt) throw new Refused(409, 'the names are not drawn yet');
  if (!opensNow(place.d, now)) throw new Refused(409, 'not yet: everyone opens together at the set time');
  needKey(ring);
  if (!place.me.openedAt) db.update(t.drawParticipant).set({ openedAt: now.toISOString() }).where(eq(t.drawParticipant.id, place.me.id)).run();
}

/** A giver opens theirs (after the draw-together time). Returns the celebration's id. */
export function openDraw(db: Db, me: Person, celebrationId: string, now: Date, ring: Keyring): string {
  const { c, d } = mustDraw(db, celebrationId);
  const mine = participantsOf(db, [d.id]).find((p) => p.kind === 'person' && p.personId === me.id);
  if (!mine) throw new Refused(403, 'you are not in this draw');
  if (!d.drawnAt) throw new Refused(409, 'the names are not drawn yet');
  if (!opensNow(d, now)) throw new Refused(409, 'not yet: everyone opens together at the set time');
  needKey(ring);
  if (!mine.openedAt) db.update(t.drawParticipant).set({ openedAt: now.toISOString() }).where(eq(t.drawParticipant.id, mine.id)).run();
  return c.id;
}

// --- The celebration's people ------------------------------------------------------------------------------------

/**
 * Before a celebration's people change: someone taken out who is in a drawn draw whose day has not come must be taken
 * out of the draw first (that is a re-draw, with its rules). In a draw not drawn yet they are simply dropped (after).
 */
export function checkPeopleChange(db: Db, celebrationId: string, people: string[], today: string): void {
  const c = mustGetCelebration(db, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d?.drawnAt || dayHasCome(c, d, today)) return;
  const leaving = participantsOf(db, [d.id]).some((p) => p.kind === 'person' && !people.includes(p.personId!));
  if (leaving) throw new Refused(409, 'they are in the draw: take them out of the draw first');
}
export function dropLeavers(db: Db, celebrationId: string, people: string[]): void {
  const d = latestDraw(db, celebrationId);
  if (!d || d.drawnAt) return;
  for (const p of participantsOf(db, [d.id])) if (p.kind === 'person' && !people.includes(p.personId!)) db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, p.id)).run();
}

/**
 * Before a celebration's day or recurrence changes: a drawn draw whose day has not come may only move later (its day
 * is latched at drawing). Returns the draws that move, to audit after the change (`auditMoves`).
 */
export function checkCelebrationMove(db: Db, me: Person, celebrationId: string, patch: { date?: string; recurrence?: 'none' | 'yearly' }, today: string): string[] {
  if (patch.date === undefined && patch.recurrence === undefined) return [];
  const c = mustGetCelebration(db, celebrationId);
  if (!canChange(me, c)) return []; // the change refuses them itself (403)
  const next = { date: patch.date ?? c.date, recurrence: patch.recurrence ?? c.recurrence };
  const drawn = db.select().from(t.draw).where(eq(t.draw.celebrationId, c.id)).all().filter((d) => d.drawnAt !== null);
  for (const d of drawn) {
    if (dayHasCome(c, d, today)) continue;
    if (dayOf(next, d.year) < occasionOf(c, d)) throw new Refused(409, 'the names are drawn: its celebration can only move later');
  }
  return drawn.filter((d) => dayOf(next, d.year) !== dayOf(c, d.year)).map((d) => d.id);
}
export function auditMoves(db: Db, me: Person, drawIds: string[]): void {
  for (const id of drawIds) audit(db, me.id, 'draw_moved', id);
}

/**
 * Before a celebration is removed: a drawn draw whose day has not come goes only under the re-draw rules (before anyone
 * opened theirs, or while nobody has bought a gift since the draw). After its day, nothing is left to break.
 */
export function checkCelebrationRemoval(db: Db, me: Person, celebrationId: string, today: string): void {
  const c = mustGetCelebration(db, celebrationId);
  if (!canChange(me, c)) return; // the removal refuses them itself (403)
  const d = latestDraw(db, c.id);
  if (d?.drawnAt && !dayHasCome(c, d, today)) mayChangePairs(db, me, c, d, today);
}

/**
 * Before someone leaves the household (review M2), for each draw they are in whose names are drawn and whose day has
 * not come: under the re-draw rules they are taken out and the names are drawn again among the others, everyone told
 * if anyone had opened theirs; if the others cannot be drawn (too few, say), the draw goes back to not drawn, also
 * told. If the re-draw rules do not allow it (someone opened theirs and a gift is bought since), they stay until its
 * day (409). In a draw whose day has come their rows simply go: whoever drew them keeps nobody, and nobody is drawn
 * for again. Run inside the removal's transaction.
 */
export function beforePersonRemoved(db: Db, me: Person, personId: string, today: string, ring: Keyring): void {
  const mine = db.select().from(t.drawParticipant).where(and(eq(t.drawParticipant.kind, 'person'), eq(t.drawParticipant.personId, personId))).all();
  for (const p of mine) {
    const d = db.select().from(t.draw).where(eq(t.draw.id, p.drawId)).get()!;
    const c = mustGetCelebration(db, d.celebrationId);
    if (!d.drawnAt || dayHasCome(c, d, today)) continue;
    try { mayChangePairs(db, me, c, d, today); } catch (e) {
      if (e instanceof Refused) throw new Refused(409, 'they are in a draw that can no longer change: remove them after its celebration');
      throw e;
    }
    const key = needKey(ring);
    veil(db, d, today);
    db.delete(t.drawParticipant).where(eq(t.drawParticipant.id, p.id)).run();
    const left = db.select().from(t.draw).where(eq(t.draw.id, d.id)).get()!;
    const next = prepare(db, left, ring);
    if ('pairs' in next) { commit(db, me, left, key, next.pairs); continue; }
    const told = anyOpened(db, left);
    db.delete(t.drawAssignment).where(eq(t.drawAssignment.drawId, d.id)).run();
    db.update(t.draw).set({ drawnAt: null, redrawnAt: told ? ts() : left.redrawnAt, updatedAt: ts() }).where(eq(t.draw.id, d.id)).run();
    db.update(t.drawParticipant).set({ openedAt: null }).where(eq(t.drawParticipant.drawId, d.id)).run();
    audit(db, me.id, 'draw_cleared', d.id);
  }
}

/**
 * Before a drawn draw that is not revealed goes, or its people change: a veil of who was in it and its day (never its
 * pairs), so the gifts they made each other under it stay unnamed (second review M3, L6). Run in the change's
 * transaction.
 */
/** A participant as unrevealedDraws keeps them: a person's id, or `g:<link id>` for a guest. */
const participantKey = (p: Participant) => p.personId ?? `g:${p.guestId}`;
export function veil(db: Db, d: Draw, today: string): void {
  const c = mustGetCelebration(db, d.celebrationId);
  if (!d.drawnAt || isRevealed(c, d, today)) return;
  const people = participantsOf(db, [d.id]).map(participantKey).sort();
  db.insert(t.drawVeil).values({ id: ulid(), drawId: d.id, peopleJson: JSON.stringify(people), on: occasionOf(c, d), revealOn: d.revealOn, createdAt: ts() }).run();
}
/**
 * Before a draw goes: its earlier veils take its day and reveal date as they are now (or go, if it is revealed), and
 * a last veil is written for it (third review L8).
 */
export function veilGoing(db: Db, d: Draw, today: string): void {
  const c = mustGetCelebration(db, d.celebrationId);
  if (isRevealed(c, d, today)) db.delete(t.drawVeil).where(eq(t.drawVeil.drawId, d.id)).run();
  else db.update(t.drawVeil).set({ on: occasionOf(c, d), revealOn: d.revealOn }).where(eq(t.drawVeil.drawId, d.id)).run();
  veil(db, d, today);
}
/** Veils every drawn, unrevealed draw of a celebration that is about to be removed. */
export function veilCelebration(db: Db, celebrationId: string, today: string): void {
  for (const d of db.select().from(t.draw).where(eq(t.draw.celebrationId, celebrationId)).all()) veilGoing(db, d, today);
}

/**
 * Every drawn draw not revealed yet, and every veil not lifted (its reveal date passed after its day), with its people
 * and day: whose gifts to each other stay unnamed (view, review H1).
 */
export function unrevealedDraws(db: Db, today: string): { people: Set<string>; on: string }[] {
  const cs = new Map(db.select().from(t.celebration).all().map((c) => [c.id, c]));
  const drawn = db.select().from(t.draw).all().filter((d) => d.drawnAt !== null && !isRevealed(cs.get(d.celebrationId)!, d, today));
  const ps = participantsOf(db, drawn.map((d) => d.id));
  const draws = new Map(db.select().from(t.draw).all().map((d) => [d.id, d]));
  // A veil whose draw lives on follows that draw: lifted only once the draw itself is revealed, its day the draw's day
  // now. A veil whose draw is gone keeps the day and reveal date copied when it went.
  const veils = db.select().from(t.drawVeil).all().flatMap((v) => {
    const d = v.drawId ? draws.get(v.drawId) : undefined;
    if (d) { const c = cs.get(d.celebrationId)!; return isRevealed(c, d, today) ? [] : [{ v, on: occasionOf(c, d) }]; }
    return v.revealOn !== null && today >= v.revealOn && today > v.on ? [] : [{ v, on: v.on }];
  });
  // A guest counts as `g:<link id>` (gifts/gifts.ts giverKey), in a veil too.
  return [
    ...drawn.map((d) => ({ people: new Set(ps.filter((p) => p.drawId === d.id).map(participantKey)), on: occasionOf(cs.get(d.celebrationId)!, d) })),
    ...veils.map(({ v, on }) => ({ people: new Set(JSON.parse(v.peopleJson) as string[]), on })),
  ];
}
/** The household's day a moment fell on (for comparing a gift's time with a draw's day, second review L7). */
export const dayOfInstant = (timeZone: string, iso: string) => dayIn(timeZone, new Date(iso));

/** Days until the draw's occasion (for the view). */
export const daysUntil = (c: Celebration, d: Draw, today: string) => daysBetween(today, occasionOf(c, d));

/**
 * `keepsake rotate-key`: every sealed row not under the current key is opened with the key its id names (the previous
 * one, KEEPSAKE_SEALING_KEY_PREVIOUS) and sealed again with the current key, in one transaction. Rows that open with
 * neither stay as they are and are counted. Returns the counts only.
 */
export function rotateKey(db: Db, ring: Keyring): { resealed: number; unreadable: number } {
  const key = needKey(ring);
  const id = keyId(key);
  let resealed = 0, unreadable = 0;
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    for (const row of tx.select().from(t.drawAssignment).all()) {
      if (row.keyId === id) continue;
      const r = openRow(ring, row.drawId, row);
      if (!r) { unreadable++; continue; }
      tx.update(t.drawAssignment).set({ sealed: sealReceiver(key, row.drawId, row.giverId, r), keyId: id })
        .where(and(eq(t.drawAssignment.drawId, row.drawId), eq(t.drawAssignment.giverId, row.giverId))).run();
      resealed++;
    }
  });
  return { resealed, unreadable };
}
