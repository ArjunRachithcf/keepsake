// Gifts (spec §3, ADR 0003): claims ("I'll get this", how many, then bought, then given) and group gifts (a target,
// each giver's share). The surprise holds here first:
//
// - Only a giver acts on gifts: someone who may see the wish, is not its person, and is not a kid (PR #8: kids see no
//   claims or shares of anyone, so nothing spoils through a kid). That is checked before anything about the wish's
//   gifts is read, so the person's (and a kid's) answer to every gift route is the same whatever the gifts are.
// - Nothing here changes a wish's own row: the person's view of their wish cannot move because someone claimed it.
// - The view layer reads gifts only for a viewer who `seesGifts`; for everyone else it reads `receivedIds`, the wishes
//   whose gifts are given and whose celebration is over (by then the person has them).
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { celebrationsOfPerson, getCelebration } from '../celebrations/celebrations';
import { daysBetween, nextDate } from '../celebrations/dates';
import { currency, getPerson, managesKid, type Person } from '../household/people';
import { getWish, seeWish, type Wish } from '../wishes/wishes';

export type Claim = typeof t.claim.$inferSelect;
export type ClaimState = Claim['state'];
export type GroupGift = typeof t.groupGift.$inferSelect;
export type GroupState = GroupGift['state'];
export type Share = typeof t.share.$inferSelect;
export interface Gifts { claims: Claim[]; group: GroupGift | null; shares: Share[] }
export const NO_GIFTS: Gifts = Object.freeze({ claims: [], group: null, shares: [] }) as Gifts;

/** Who sees a wish's gifts: anyone but its person, and no kid. A kid's managers do (they coordinate). */
export const seesGifts = (me: Pick<Person, 'id' | 'role'>, w: Pick<Wish, 'personId'>): boolean => me.id !== w.personId && me.role !== 'kid';

/** A given gift reaches its person after the day it was for (or, with no celebration, the day after it was given). */
type Dated = { state: string; forDate: string | null; givenOn: string | null };
export const revealOn = (g: Dated): string | null => g.forDate ?? g.givenOn;
export const isOver = (g: Dated, today: string): boolean => g.state === 'given' && (revealOn(g) ?? today) < today;

/** Every unit given (a giver's view: gone everywhere). */
export function fullyGiven(w: Pick<Wish, 'quantity'>, g: Gifts): boolean {
  if (g.group) return g.group.state === 'given';
  return g.claims.filter((c) => c.state === 'given').reduce((n, c) => n + c.quantity, 0) >= w.quantity;
}

/** Every unit given and its celebration over (the person's view, and a kid's: gone from then on). */
export function received(w: Pick<Wish, 'quantity'>, g: Gifts, today: string): boolean {
  if (g.group) return isOver(g.group, today);
  return g.claims.filter((c) => isOver(c, today)).reduce((n, c) => n + c.quantity, 0) >= w.quantity;
}

/** The gifts of these wishes (for the view layer, and only for a viewer who sees them). */
export function giftsOf(db: Db, wishIds: string[]): Map<string, Gifts> {
  const m = new Map<string, Gifts>();
  if (!wishIds.length) return m;
  const at = (id: string) => { let g = m.get(id); if (!g) m.set(id, g = { claims: [], group: null, shares: [] }); return g; };
  for (const c of db.select().from(t.claim).where(inArray(t.claim.wishId, wishIds)).all()) at(c.wishId).claims.push(c);
  for (const g of db.select().from(t.groupGift).where(inArray(t.groupGift.wishId, wishIds)).all()) at(g.wishId).group = g;
  for (const s of db.select().from(t.share).where(inArray(t.share.wishId, wishIds)).all()) at(s.wishId).shares.push(s);
  return m;
}

/** The gifts that have been given, by wish (the person's thank-yous and a giver's "gifts you gave"). */
function givenGifts(db: Db): Map<string, Gifts> {
  const ids = new Set([
    ...db.select({ id: t.claim.wishId }).from(t.claim).where(eq(t.claim.state, 'given')).all().map((r) => r.id),
    ...db.select({ id: t.groupGift.wishId }).from(t.groupGift).where(eq(t.groupGift.state, 'given')).all().map((r) => r.id),
  ]);
  return giftsOf(db, [...ids]);
}

/** Wishes whose gifts have all been given and whose celebration is over: the one thing a non-giver's lists follow. */
export function receivedIds(db: Db, today: string): Set<string> {
  const given = givenGifts(db);
  const wishes = given.size ? db.select({ id: t.wish.id, quantity: t.wish.quantity }).from(t.wish).where(inArray(t.wish.id, [...given.keys()])).all() : [];
  return new Set(wishes.filter((w) => received(w, given.get(w.id)!, today)).map((w) => w.id));
}

export interface Thanks { wish: Wish; celebrationId: string | null; on: string; from: string[] }

/**
 * The thank-yous: the viewer's wishes (and, for a kid's parent, the kid's: they help write them) with a gift given
 * whose celebration is over, and of its givers only those who chose to put their name on it. The others stay hidden
 * for good. Never before the occasion is over, for the parent as for the kid.
 */
export function thanksFor(db: Db, viewer: Person, today: string): Thanks[] {
  const given = givenGifts(db);
  const out: Thanks[] = [];
  const forViewer = (personId: string) => {
    if (personId === viewer.id) return true;
    const owner = getPerson(db, personId);
    return Boolean(owner && managesKid(db, viewer, owner));
  };
  for (const [wishId, g] of given) {
    const w = getWish(db, wishId);
    if (!w || !forViewer(w.personId)) continue;
    const over = g.group ? (isOver(g.group, today) ? [g.group] : []) : g.claims.filter((c) => isOver(c, today));
    if (!over.length) continue;
    const from = g.group ? g.shares.filter((s) => s.named).map((s) => s.giverId) : g.claims.filter((c) => isOver(c, today) && c.named).map((c) => c.giverId);
    const last = over.map((x) => ({ on: revealOn(x)!, celebrationId: x.celebrationId })).sort((a, b) => b.on.localeCompare(a.on))[0]!;
    out.push({ wish: w, celebrationId: last.celebrationId, on: last.on, from });
  }
  return out.sort((a, b) => b.on.localeCompare(a.on) || a.wish.name.localeCompare(b.wish.name)).slice(0, 100);
}

export interface Gave { wish: Wish; celebrationId: string | null; on: string; named: boolean }

/** A giver's own gifts given whose celebration is over: where they choose to put their name on each. */
export function gaveBy(db: Db, giverId: string, today: string): Gave[] {
  const out: Gave[] = [];
  for (const [wishId, g] of givenGifts(db)) {
    const w = getWish(db, wishId);
    if (!w) continue;
    const mine = g.group ? g.shares.find((s) => s.giverId === giverId) : g.claims.find((c) => c.giverId === giverId);
    const dated = g.group ?? (mine as Claim | undefined);
    if (!mine || !dated || !isOver(dated, today)) continue;
    out.push({ wish: w, celebrationId: dated.celebrationId, on: revealOn(dated)!, named: mine.named === 1 });
  }
  return out.sort((a, b) => b.on.localeCompare(a.on) || a.wish.name.localeCompare(b.wish.name)).slice(0, 100);
}

// --- What givers do ---------------------------------------------------------------------------------------------

/**
 * The wish a giver acts on: one they may see (else 404, as for any hidden wish), and theirs to give (else 403). Both
 * are decided from the wish and the caller alone, before anything about gifts is read.
 */
function giving(db: Db, me: Person, wishId: string): Wish {
  const w = seeWish(db, me, wishId);
  if (me.id === w.personId) throw new Refused(403, 'your own wishes are for others to give');
  if (me.role === 'kid') throw new Refused(403, 'grown-ups claim gifts and chip in');
  return w;
}
const listed = (w: Wish) => {
  if (w.state !== 'listed') throw new Refused(409, 'only a wish on the list can be given');
};

/** The occasion a gift is for: the wish's celebration (its next date), or the person's next celebration, or none. */
function occasion(db: Db, w: Wish, today: string): { celebrationId: string | null; forDate: string | null } {
  const c = w.celebrationId ? getCelebration(db, w.celebrationId) : undefined;
  if (c) return { celebrationId: c.id, forDate: nextDate(c.date, c.recurrence, today) };
  const next = celebrationsOfPerson(db, w.personId).map((x) => ({ x, d: nextDate(x.date, x.recurrence, today) }))
    .filter((n) => n.d >= today).sort((a, b) => a.d.localeCompare(b.d) || a.x.name.localeCompare(b.x.name))[0];
  return next ? { celebrationId: next.x.id, forDate: next.d } : { celebrationId: null, forDate: null };
}

/**
 * Marking given: the occasion stays the one it was claimed for, unless that day is more than a month gone (a claim
 * left over from a past year), then it is the next one. Given a little late, the person learns it the next day.
 */
const STALE_DAYS = 30;
function givenNow<T extends Dated & { celebrationId: string | null }>(db: Db, w: Wish, g: T, today: string) {
  const fresh = g.forDate && daysBetween(g.forDate, today) > STALE_DAYS ? occasion(db, w, today) : { celebrationId: g.celebrationId, forDate: g.forDate };
  return { ...fresh, givenOn: today };
}
const notGiven = { givenOn: null };

function myClaim(db: Db, me: Person, wishId: string): Claim | undefined {
  return db.select().from(t.claim).where(and(eq(t.claim.wishId, wishId), eq(t.claim.giverId, me.id))).get();
}
function groupOf(db: Db, wishId: string): GroupGift | undefined {
  return db.select().from(t.groupGift).where(eq(t.groupGift.wishId, wishId)).get();
}
function mustGroup(db: Db, wishId: string): GroupGift {
  const g = groupOf(db, wishId);
  if (!g) throw new Refused(404, 'it is not a group gift');
  return g;
}
const ts = () => new Date().toISOString();

/** "I'll get this" (or change how many): within what is left, not on a group gift, not once you have given it. */
export function claimWish(db: Db, me: Person, wishId: string, quantity: number, today: string): Wish {
  const w = giving(db, me, wishId);
  listed(w);
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    if (groupOf(tx, w.id)) throw new Refused(409, 'it is a group gift: chip in instead');
    const claims = tx.select().from(t.claim).where(eq(t.claim.wishId, w.id)).all();
    const mine = claims.find((c) => c.giverId === me.id);
    if (mine?.state === 'given') throw new Refused(409, 'you have given it already');
    const others = claims.filter((c) => c.giverId !== me.id).reduce((n, c) => n + c.quantity, 0);
    if (others + quantity > w.quantity) throw new Refused(409, others >= w.quantity ? 'someone is getting it already' : 'not that many are left to claim');
    if (mine) tx.update(t.claim).set({ quantity, updatedAt: ts() }).where(eq(t.claim.id, mine.id)).run();
    else tx.insert(t.claim).values({ id: ulid(), wishId: w.id, giverId: me.id, quantity, state: 'claimed', ...occasion(tx, w, today), createdAt: ts(), updatedAt: ts() }).run();
  });
  return w;
}

/** Bought, given, or back: a given gift whose celebration is over stays given (its person has seen it by then). */
export function setClaimState(db: Db, me: Person, wishId: string, state: ClaimState, today: string): Wish {
  const w = giving(db, me, wishId);
  const c = myClaim(db, me, w.id);
  if (!c) throw new Refused(404, 'you have not claimed it');
  if (c.state === state) return w;
  if (isOver(c, today)) throw new Refused(409, 'it was given, and its celebration is over');
  const dates = state === 'given' ? givenNow(db, w, c, today) : notGiven;
  db.update(t.claim).set({ state, ...dates, named: state === 'given' ? c.named : 0, updatedAt: ts() }).where(eq(t.claim.id, c.id)).run();
  return w;
}

export function unclaimWish(db: Db, me: Person, wishId: string): void {
  const w = giving(db, me, wishId);
  const c = myClaim(db, me, w.id);
  if (!c) throw new Refused(404, 'you have not claimed it');
  if (c.state === 'given') throw new Refused(409, 'it is given: mark it not given first');
  db.delete(t.claim).where(eq(t.claim.id, c.id)).run();
}

/** After the celebration, a giver puts their name on what they gave (or takes it off): the person sees it to thank them. */
export function setNamed(db: Db, me: Person, wishId: string, named: boolean, today: string): Wish {
  const w = giving(db, me, wishId);
  const g = groupOf(db, w.id);
  const mine = g ? db.select().from(t.share).where(and(eq(t.share.wishId, w.id), eq(t.share.giverId, me.id))).get() : myClaim(db, me, w.id);
  const dated = g ?? (mine as Claim | undefined);
  if (!mine || !dated || !isOver(dated, today)) throw new Refused(409, 'only for a gift you gave, once its celebration is over');
  const set = { named: named ? 1 : 0, updatedAt: ts() };
  if (g) db.update(t.share).set(set).where(and(eq(t.share.wishId, w.id), eq(t.share.giverId, me.id))).run();
  else db.update(t.claim).set(set).where(eq(t.claim.id, (mine as Claim).id)).run();
  return w;
}

/** Makes a wish a group gift with a target (the household's currency first); not one somebody has claimed. */
export function startGroup(db: Db, me: Person, wishId: string, targetMinor: number, today: string): Wish {
  const w = giving(db, me, wishId);
  listed(w);
  if (!currency(db)) throw new Refused(409, 'the household has no currency yet: an admin sets it first');
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    if (groupOf(tx, w.id)) throw new Refused(409, 'it is a group gift already');
    if (tx.select({ id: t.claim.id }).from(t.claim).where(eq(t.claim.wishId, w.id)).get()) throw new Refused(409, 'someone is getting it already');
    tx.insert(t.groupGift).values({ wishId: w.id, organizerId: me.id, targetMinor, state: 'open', ...occasion(tx, w, today), createdAt: ts(), updatedAt: ts() }).run();
  });
  return w;
}

/** Whoever started it runs it; if they have left the household, anyone who chipped in. */
export function managesGroup(db: Db, me: Pick<Person, 'id'>, g: GroupGift): boolean {
  if (g.organizerId) return g.organizerId === me.id;
  return Boolean(db.select().from(t.share).where(and(eq(t.share.wishId, g.wishId), eq(t.share.giverId, me.id))).get());
}

export function editGroup(db: Db, me: Person, wishId: string, patch: { targetMinor?: number; state?: GroupState }, today: string): Wish {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (!managesGroup(db, me, g)) throw new Refused(403, 'whoever started the group gift changes it');
  if (patch.targetMinor !== undefined && g.state !== 'open') throw new Refused(409, 'it is bought: the target stays');
  const state = patch.state ?? g.state;
  if (state !== g.state && isOver(g, today)) throw new Refused(409, 'it was given, and its celebration is over');
  const dates = state === g.state ? {} : state === 'given' ? givenNow(db, w, g, today) : notGiven;
  const named = state !== 'given' && g.state === 'given';
  db.transaction((tx) => {
    tx.update(t.groupGift).set({ targetMinor: patch.targetMinor ?? g.targetMinor, state, ...dates, updatedAt: ts() }).where(eq(t.groupGift.wishId, w.id)).run();
    if (named) tx.update(t.share).set({ named: 0 }).where(eq(t.share.wishId, w.id)).run();
  });
  return w;
}

/** Back to a plain wish, while nobody else has chipped in. */
export function endGroup(db: Db, me: Person, wishId: string): void {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (!managesGroup(db, me, g)) throw new Refused(403, 'whoever started the group gift changes it');
  const shares = db.select().from(t.share).where(eq(t.share.wishId, w.id)).all();
  if (shares.some((s) => s.giverId !== me.id)) throw new Refused(409, 'others have chipped in: they take their share back first');
  db.delete(t.groupGift).where(eq(t.groupGift.wishId, w.id)).run();
}

/** Chips in (or changes your share) while the group gift is open. */
export function chipIn(db: Db, me: Person, wishId: string, amountMinor: number): Wish {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (g.state !== 'open') throw new Refused(409, 'it is bought: shares stay as they are');
  db.insert(t.share).values({ wishId: w.id, giverId: me.id, amountMinor, createdAt: ts(), updatedAt: ts() })
    .onConflictDoUpdate({ target: [t.share.wishId, t.share.giverId], set: { amountMinor, updatedAt: ts() } }).run();
  return w;
}

export function withdrawShare(db: Db, me: Person, wishId: string): void {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (g.state !== 'open') throw new Refused(409, 'it is bought: shares stay as they are');
  const r = db.delete(t.share).where(and(eq(t.share.wishId, w.id), eq(t.share.giverId, me.id))).run();
  if (!r.changes) throw new Refused(404, 'you have not chipped in');
}
