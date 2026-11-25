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
import { randomInt } from 'node:crypto';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import { DrawError, draw as drawNames, feasible, type Blocker, type Rules } from '@keepsake/draw';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { Refused, type Message } from '../errors';
import { mustGetCelebration, peopleOf, type Celebration } from '../celebrations/celebrations';
import { daysBetween, nextDate, onYear } from '../celebrations/dates';
import { currency, getPerson, type Person } from '../household/people';
import { SealError, keyId, openReceiver, sealReceiver } from './sealed';

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

/** Tries to draw (drawn, re-drawn or refused) per draw and day: bounds how often a host can ask "is this possible?". */
export const RUNS_A_DAY = 20;
export const MAX_EXCLUSIONS = 200;

const ts = () => new Date().toISOString();

// --- Reading -----------------------------------------------------------------------------------------------------

/** The year of the celebration's next day on or after `today`: the year a new draw is for. */
export const drawYear = (c: Celebration, today: string) => Number(nextDate(c.date, c.recurrence, today).slice(0, 4));
/** The draw's occasion: the celebration's day in the draw's year, as the celebration is now. */
export const occasionOf = (c: Pick<Celebration, 'date' | 'recurrence'>, d: Pick<Draw, 'year'>) => (c.recurrence === 'yearly' ? onYear(c.date, d.year) : c.date);
/** Its day has come: from then on only the reveal date changes. */
export const dayHasCome = (c: Celebration, d: Draw, today: string) => today >= occasionOf(c, d);
/** Every pair is shown to the participants (and the host) from the reveal date on, and never before the day after the celebration. */
export const isRevealed = (c: Celebration, d: Draw, today: string) => d.revealOn !== null && today >= d.revealOn && today > occasionOf(c, d);
/** Whether a giver may open theirs now. */
export const opensNow = (d: Draw, now: Date) => d.drawnAt !== null && (d.drawTogetherAt === null || now.getTime() >= Date.parse(d.drawTogetherAt));

/** The host runs the draw; a celebration whose host has left, an admin. Never a kid. */
export const managesDraw = (me: Pick<Person, 'id' | 'role'>, c: Pick<Celebration, 'hostId'>) =>
  me.role !== 'kid' && (c.hostId ? c.hostId === me.id : me.role === 'admin');

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

/** The caller's own receiver (a participant id), once they have opened their draw; null otherwise. */
export function openOwn(db: Db, key: Buffer, d: Draw, me: Participant): string | null {
  if (!me.openedAt || me.drawId !== d.id) return null;
  const row = db.select().from(t.drawAssignment).where(and(eq(t.drawAssignment.drawId, d.id), eq(t.drawAssignment.giverId, me.id))).get();
  return row ? openReceiver(key, d.id, me.id, row.sealed) : null;
}

/** Every giver → receiver (participant ids). Only after the reveal (the view layer) or inside a new draw (last year's). */
export function openAll(db: Db, key: Buffer, d: Draw): Map<string, string> {
  return new Map(db.select().from(t.drawAssignment).where(eq(t.drawAssignment.drawId, d.id)).all()
    .map((row) => [row.giverId, openReceiver(key, d.id, row.giverId, row.sealed)]));
}

// --- Changing ----------------------------------------------------------------------------------------------------

function audit(db: Db, actorId: string, action: (typeof t.AUDIT_ACTIONS)[number], drawId: string) {
  db.insert(t.audit).values({ id: ulid(), at: ts(), actorId, action, subjectId: drawId }).run();
}

function managing(db: Db, me: Person, celebrationId: string): Celebration {
  const c = mustGetCelebration(db, celebrationId);
  if (!managesDraw(me, c)) throw new Refused(403, 'only the celebration\'s host runs its draw');
  return c;
}

/** The input checked against the celebration and the household; returns it with duplicates gone. */
function checked(db: Db, c: Celebration, i: DrawInput, d: Pick<Draw, 'year'>): DrawInput {
  const inCelebration = new Set(peopleOf(db, c.id));
  const people = [...new Set(i.people)];
  for (const id of people) {
    const p = getPerson(db, id);
    if (!p || !inCelebration.has(id)) throw new Refused(400, 'people: someone is not in the celebration');
    if (p.role === 'kid' && !i.kidsDraw) throw new Refused(400, 'people: a kid draws only when kids draw too');
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
      byPerson.set(id, { ...row, openedAt: null });
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
  const d0 = { year };
  if (today >= occasionOf(c, d0)) throw new Refused(409, 'its day has come: the draw stays as it is');
  if (db.select({ id: t.draw.id }).from(t.draw).where(and(eq(t.draw.celebrationId, c.id), eq(t.draw.year, year))).get()) {
    throw new Refused(409, 'this celebration has a draw already');
  }
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
  const persons = participantsOf(db, [d.id]).filter((p) => p.kind === 'person').map((p) => p.personId!);
  const others = persons.filter((p) => p !== caller);
  if (!others.length) return false;
  const wishes = db.select({ id: t.wish.id }).from(t.wish).where(and(inArray(t.wish.personId, others), eq(t.wish.state, 'listed'),
    or(eq(t.wish.celebrationId, c.id), isNull(t.wish.celebrationId)))).all().map((w) => w.id);
  if (!wishes.length) return false;
  const since = d.drawnAt!;
  const claim = db.select({ id: t.claim.id }).from(t.claim).where(and(inArray(t.claim.wishId, wishes), inArray(t.claim.giverId, persons),
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
  if (!managesDraw(me, c)) return false;
  try { mayChangePairs(db, me, c, d, today); return true; } catch { return false; }
}

const BLOCKED: Record<Blocker, Message> = {
  too_few: 'a draw needs at least 3 people',
  too_many: 'a draw holds at most 100 people',
  exclusions: 'who shouldn\'t draw whom leaves someone nobody to draw: loosen it',
  last_year: 'not last year\'s person leaves no way to draw: turn it off or loosen who shouldn\'t draw whom',
  too_tight: 'the rules leave too few ways to draw: loosen them',
};

/** Last year's pairs in this draw's participant ids (by person), for "not last year's person". */
function lastYearOf(db: Db, key: Buffer, d: Draw, ps: Participant[]): Map<string, string> | null {
  if (!d.notLastYear) return null;
  const last = db.select().from(t.draw).where(and(eq(t.draw.celebrationId, d.celebrationId), eq(t.draw.year, d.year - 1))).get();
  if (!last?.drawnAt) return null;
  const lastPs = participantsOf(db, [last.id]);
  const personOf = new Map(lastPs.map((p) => [p.id, p.personId]));
  const nowOf = new Map(ps.map((p) => [p.personId, p.id]));
  let pairs: Map<string, string>;
  try { pairs = openAll(db, key, last); } catch (e) {
    if (e instanceof SealError) throw new Refused(409, 'last year\'s draw does not open with this key: turn off not last year\'s person');
    throw e;
  }
  const out = new Map<string, string>();
  for (const [g, r] of pairs) {
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

function runsToday(db: Db, drawId: string): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return db.select({ id: t.audit.id }).from(t.audit).where(and(eq(t.audit.subjectId, drawId), inArray(t.audit.action, ['drawn', 'redrawn', 'draw_refused']), gte(t.audit.at, since))).all().length;
}

/** The new pairs under the rules as they are in the database now, or the rule that blocks them. */
function prepare(db: Db, d: Draw, key: Buffer): { pairs: Map<string, string> } | { blocked: Blocker } {
  const ps = participantsOf(db, [d.id]).filter((p) => p.kind === 'person').sort((a, b) => a.id.localeCompare(b.id));
  const ids = ps.map((p) => p.id);
  const rules: Rules = { exclusions: exclusionsOf(db, d.id).map((e) => [e.a, e.b] as const), lastYear: lastYearOf(db, key, d, ps) };
  const f = feasible(ids, rules);
  if (!f.ok) return { blocked: f.rule };
  try { return { pairs: drawNames(ids, rules, (n) => randomInt(n)) }; } catch (e) { if (e instanceof DrawError) return { blocked: e.rule }; throw e; }
}

/**
 * Seals the new pairs in place of the old ones; after someone had opened theirs, everyone opens theirs again. Run in
 * the caller's transaction.
 */
function commit(db: Db, me: Person, d: Draw, key: Buffer, pairs: Map<string, string>): void {
  const again = d.drawnAt !== null;
  const told = again && anyOpened(db, d);
  sealAssignments(db, key, d.id, pairs);
  db.update(t.draw).set({ drawnAt: ts(), redrawnAt: told ? ts() : d.redrawnAt, updatedAt: ts() }).where(eq(t.draw.id, d.id)).run();
  if (told) db.update(t.drawParticipant).set({ openedAt: null }).where(eq(t.drawParticipant.drawId, d.id)).run();
  audit(db, me.id, again ? 'redrawn' : 'drawn', d.id);
}

/** A refused try: audited (outside any transaction that is rolled back), then refused naming the rule. */
function refuse(db: Db, me: Person, d: Draw, rule: Blocker): never {
  audit(db, me.id, 'draw_refused', d.id);
  throw new Refused(409, BLOCKED[rule]);
}
const often = (db: Db, d: Draw) => {
  if (runsToday(db, d.id) >= RUNS_A_DAY) throw new Refused(409, 'the names were drawn often today: try again tomorrow');
};
class Blocked { constructor(readonly rule: Blocker) {} }

const needKey = (key: Buffer | null): Buffer => {
  if (!key) throw new Refused(409, 'draws need the sealing key on the server (KEEPSAKE_SEALING_KEY)');
  return key;
};

/** Draw (or re-draw) the names. Returns the celebration's id. */
export function runDraw(db: Db, me: Person, celebrationId: string, today: string, key: Buffer | null): string {
  const c = managing(db, me, celebrationId);
  const d = latestDraw(db, c.id);
  if (!d) throw new Refused(404, 'this celebration has no draw');
  mayChangePairs(db, me, c, d, today);
  const k = needKey(key);
  often(db, d);
  const p = prepare(db, d, k);
  if ('blocked' in p) refuse(db, me, d, p.blocked);
  db.transaction((tx) => commit(asDb(tx), me, d, k, p.pairs));
  return c.id;
}

/**
 * Changes the draw. Once its day has come only the reveal date changes. Once drawn, a change to who draws or the rules
 * draws the names again, under the re-draw rules. Returns the celebration's id.
 */
export function editDraw(db: Db, me: Person, celebrationId: string, patch: Partial<DrawInput>, today: string, key: Buffer | null): string {
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
  if (rulesChange && d.drawnAt) mayChangePairs(db, me, c, d, today);
  const k = rulesChange && d.drawnAt ? needKey(key) : null;
  if (k) often(db, d);
  try {
    db.transaction((tx0) => {
      const tx = asDb(tx0);
      tx.update(t.draw).set({ ...settings(next), updatedAt: ts() }).where(eq(t.draw.id, d.id)).run();
      if (rulesChange) writeRules(tx, d.id, next);
      audit(tx, me.id, 'draw_changed', d.id);
      if (!same('revealOn')) audit(tx, me.id, 'reveal_set', d.id);
      if (!k) return;
      // Drawn again under the new rules in the same transaction: a refusal leaves the rules as they were.
      const p = prepare(tx, d, k);
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
    tx.delete(t.draw).where(eq(t.draw.id, d.id)).run();
    audit(asDb(tx), me.id, 'draw_removed', d.id);
  });
}

/** A giver opens theirs (after the draw-together time). Returns the celebration's id. */
export function openDraw(db: Db, me: Person, celebrationId: string, now: Date, key: Buffer | null): string {
  const { c, d } = mustDraw(db, celebrationId);
  const mine = participantsOf(db, [d.id]).find((p) => p.kind === 'person' && p.personId === me.id);
  if (!mine) throw new Refused(403, 'you are not in this draw');
  if (!d.drawnAt) throw new Refused(409, 'the names are not drawn yet');
  if (!opensNow(d, now)) throw new Refused(409, 'not yet: everyone opens together at the set time');
  needKey(key);
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

/** Days until the draw's occasion (for the view). */
export const daysUntil = (c: Celebration, d: Draw, today: string) => daysBetween(today, occasionOf(c, d));
