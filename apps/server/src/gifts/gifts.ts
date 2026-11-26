// Gifts (spec §3, ADR 0003): claims ("I'll get this", how many, then bought, then given) and group gifts (a target,
// each giver's share). The surprise holds here first:
//
// - Only a giver acts on gifts: someone who may see the wish, is not its person, and is not a kid (PR #8: kids see no
//   claims or shares of anyone, so nothing spoils through a kid). That is checked before anything about the wish's
//   gifts is read, so the person's (and a kid's) answer to every gift route is the same whatever the gifts are.
// - Nothing here changes a wish's own row: the person's view of their wish cannot move because someone claimed it.
// - When a given gift reaches its person is computed when read (`revealDay`): the day after the later of the occasion
//   stored when it was given, the wish's current occasion and the day it was given. So it only ever moves later: a
//   postponed celebration or a moved wish postpones it, nothing brings it forward. Once its person has it,
//   `revealed_on` latches it: it stays theirs.
// - The view layer reads gifts only for a viewer who `seesGifts`. Everyone else's lists follow `revealed()`, what the
//   household has received: built once a day and after each change by whoever makes it (`refreshRevealed`), so a
//   person's own reading requests do the same work whatever is hidden from them.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { allCelebrations, peopleByCelebration, type Celebration } from '../celebrations/celebrations';
import { nextDate } from '../celebrations/dates';
import { currency, getPerson, managesKid, type Person } from '../household/people';
import { seeWish, type Wish } from '../wishes/wishes';

export type Claim = typeof t.claim.$inferSelect;
export type ClaimState = Claim['state'];
export type GroupGift = typeof t.groupGift.$inferSelect;
export type GroupState = GroupGift['state'];
export type Share = typeof t.share.$inferSelect;
export interface Gifts { claims: Claim[]; group: GroupGift | null; shares: Share[] }
export const NO_GIFTS: Gifts = Object.freeze({ claims: [], group: null, shares: [] }) as Gifts;

/** Who sees a wish's gifts: anyone but its person, and no kid. A kid's managers do (they coordinate). */
export const seesGifts = (me: Pick<Person, 'id' | 'role'>, w: Pick<Wish, 'personId'>): boolean => me.id !== w.personId && me.role !== 'kid';

// --- When a gift reaches its person (decided 2026-11-25, PR #9 review) ----------------------------------------------

/** The household's celebrations and who is in them, read once for an answer. */
export interface Calendar { byId: Map<string, Celebration>; ofPerson: (personId: string) => Celebration[] }
export function calendarOf(db: Db): Calendar {
  const all = allCelebrations(db);
  const people = peopleByCelebration(db);
  return { byId: new Map(all.map((c) => [c.id, c])), ofPerson: (id) => all.filter((c) => people.get(c.id)?.includes(id)) };
}

/** A yearly celebration's day a gift given on `on` counts for: one up to this many days before (a late gift), or the next. */
export const LATE_DAYS = 30;
const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const occurrence = (c: Celebration, on: string) => (c.recurrence === 'none' ? c.date : nextDate(c.date, 'yearly', minusDays(on, LATE_DAYS)));

type WishFor = Pick<Wish, 'personId' | 'celebrationId' | 'wasFor'>;
/**
 * The occasion a gift given on `on` is for, as the wish is now: its celebration's day (a yearly one: the day it counts
 * for); for a wish that became any time when its one-off celebration passed, that day if it is at most LATE_DAYS
 * before `on` (a late gift for the party); for any other any-time wish (or one whose celebration was removed), the
 * person's next celebration on or after `on`; else none.
 */
export function occasionOf(w: WishFor, on: string, cal: Calendar): { celebrationId: string | null; date: string | null } {
  const c = w.celebrationId ? cal.byId.get(w.celebrationId) : undefined;
  if (c) return { celebrationId: c.id, date: occurrence(c, on) };
  const was = w.wasFor ? cal.byId.get(w.wasFor) : undefined;
  if (was && was.recurrence === 'none' && was.date >= minusDays(on, LATE_DAYS)) return { celebrationId: was.id, date: was.date };
  const next = cal.ofPerson(w.personId).map((x) => ({ x, d: nextDate(x.date, x.recurrence, on) })).filter((n) => n.d >= on)
    .sort((a, b) => a.d.localeCompare(b.d) || a.x.name.localeCompare(b.x.name))[0];
  return next ? { celebrationId: next.x.id, date: next.d } : { celebrationId: null, date: null };
}

type Given = { state: string; givenOn: string | null; occasionOn: string | null; revealedOn: string | null };
/**
 * The last day a given gift stays hidden from its person: the latest of the occasion stored when it was given, the
 * wish's current occasion and the day it was given. It never moves earlier.
 */
export function revealDay(w: WishFor, g: Pick<Given, 'givenOn' | 'occasionOn'> & { givenOn: string }, cal: Calendar): string {
  return [g.givenOn, g.occasionOn, occasionOf(w, g.givenOn, cal).date].filter((d): d is string => d !== null).sort().at(-1)!;
}

/** Given, and its person has it: from the day after `revealDay`, or since it was latched (`revealed_on`). */
export const isOver = (w: WishFor, g: Given, cal: Calendar, today: string): boolean =>
  g.state === 'given' && g.givenOn !== null && (g.revealedOn !== null || revealDay(w, { ...g, givenOn: g.givenOn }, cal) < today);
/** The day shown for a gift its person has: its reveal day, or (latched after a date moved later) the day before the latch. */
const shownOn = (w: WishFor, g: Given, cal: Calendar, today: string): string => {
  const d = revealDay(w, { ...g, givenOn: g.givenOn! }, cal);
  return d < today || !g.revealedOn ? d : minusDays(g.revealedOn, 1);
};

/** Every unit given (a giver's view: gone everywhere). */
export function fullyGiven(w: Pick<Wish, 'quantity'>, g: Gifts): boolean {
  if (g.group) return g.group.state === 'given';
  return g.claims.filter((c) => c.state === 'given').reduce((n, c) => n + c.quantity, 0) >= w.quantity;
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

/** A gift its person has (given, and the occasion over): one entry per wish, with who gave it and who is named. */
export interface Over {
  wishId: string; personId: string; celebrationId: string | null; on: string;
  givers: { giverId: string | null; named: boolean }[];
  /** Every unit of the wish is given and over: gone from its person's (and kids') lists. */
  received: boolean;
}
export interface Revealed { day: string; over: Over[]; received: Set<string> }

function computeRevealed(db: Db, today: string): Revealed {
  const ids = new Set([
    ...db.select({ id: t.claim.wishId }).from(t.claim).where(isNotNull(t.claim.givenOn)).all().map((r) => r.id),
    ...db.select({ id: t.groupGift.wishId }).from(t.groupGift).where(isNotNull(t.groupGift.givenOn)).all().map((r) => r.id),
  ]);
  const gifts = giftsOf(db, [...ids]);
  const cal = calendarOf(db);
  const wishes = ids.size ? db.select().from(t.wish).where(inArray(t.wish.id, [...ids])).all() : [];
  const over: Over[] = [];
  const latch: { claims: string[]; groups: string[] } = { claims: [], groups: [] };
  for (const w of wishes) {
    const g = gifts.get(w.id)!;
    const done: Given[] = g.group ? (isOver(w, g.group, cal, today) ? [g.group] : []) : g.claims.filter((c) => isOver(w, c, cal, today));
    if (!done.length) continue;
    if (g.group && !g.group.revealedOn) latch.groups.push(g.group.wishId);
    for (const c of g.group ? [] : (done as Claim[])) if (!c.revealedOn) latch.claims.push(c.id);
    const last = done.reduce((a, b) => (shownOn(w, b, cal, today) > shownOn(w, a, cal, today) ? b : a));
    over.push({
      wishId: w.id, personId: w.personId, celebrationId: occasionOf(w, last.givenOn!, cal).celebrationId, on: shownOn(w, last, cal, today),
      givers: (g.group ? g.shares : (done as Claim[])).map((x) => ({ giverId: x.giverId, named: x.named === 1 })),
      received: g.group ? true : (done as Claim[]).reduce((n, c) => n + c.quantity, 0) >= w.quantity,
    });
  }
  // Latched: from today on its person has it, whatever the dates do later.
  if (latch.claims.length) db.update(t.claim).set({ revealedOn: today }).where(inArray(t.claim.id, latch.claims)).run();
  if (latch.groups.length) db.update(t.groupGift).set({ revealedOn: today }).where(inArray(t.groupGift.wishId, latch.groups)).run();
  over.sort((a, b) => b.on.localeCompare(a.on) || a.wishId.localeCompare(b.wishId));
  return { day: today, over, received: new Set(over.filter((o) => o.received).map((o) => o.wishId)) };
}

const REVEALED = new WeakMap<Db, Revealed>();
/** After any change to gifts, wishes, celebrations or people: rebuilt by whoever made the change (data.ts). */
export function refreshRevealed(db: Db, today: string): void {
  REVEALED.set(db, computeRevealed(db, today));
}
/** What the household has received by `today` (rebuilt once a day besides the changes). */
export function revealed(db: Db, today: string): Revealed {
  const r = REVEALED.get(db);
  if (r && r.day === today) return r;
  refreshRevealed(db, today);
  return REVEALED.get(db)!;
}

export interface Thanks { wishId: string; celebrationId: string | null; on: string; from: string[] }
/**
 * The thank-yous: the viewer's received gifts (and, for a kid's parent, the kid's: they help write them), naming only
 * the givers who chose it. The others stay hidden for good. Never before the occasion is over.
 */
export function thanksFor(db: Db, viewer: Person, today: string): Thanks[] {
  const mine = (personId: string) => {
    if (personId === viewer.id) return true;
    const owner = getPerson(db, personId);
    return Boolean(owner && managesKid(db, viewer, owner));
  };
  return revealed(db, today).over.filter((o) => mine(o.personId)).slice(0, 100).map((o) => ({
    wishId: o.wishId, celebrationId: o.celebrationId, on: o.on,
    from: o.givers.filter((x) => x.named && x.giverId).map((x) => x.giverId!),
  }));
}

export interface Gave { wishId: string; celebrationId: string | null; on: string; named: boolean }
/** A giver's own gifts that their person has: where they choose to put their name on each. */
export function gaveBy(db: Db, giverId: string, today: string): Gave[] {
  return revealed(db, today).over.flatMap((o) => {
    const me = o.givers.find((x) => x.giverId === giverId);
    return me ? [{ wishId: o.wishId, celebrationId: o.celebrationId, on: o.on, named: me.named }] : [];
  }).slice(0, 100);
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
const overNow = (db: Db, w: Wish, g: Given, today: string) => isOver(w, g, calendarOf(db), today);
/** Marked given today: the occasion's day as it is now is kept, so the reveal can only move later from here. */
export const givenFields = (db: Db, w: Wish, given: boolean, today: string) =>
  (given ? { givenOn: today, occasionOn: occasionOf(w, today, calendarOf(db)).date } : { givenOn: null, occasionOn: null });

/** Who gives: someone of the household, or a guest by their link (ADR 0009). */
export type Giver = { personId: string } | { guestId: string };
const giverIs = (who: Giver) => ('personId' in who ? eq(t.claim.giverId, who.personId) : eq(t.claim.guestId, who.guestId));
const isGivers = (c: Pick<Claim, 'giverId' | 'guestId'>, who: Giver) => ('personId' in who ? c.giverId === who.personId : c.guestId !== null && c.guestId === who.guestId);
/** One key per giver across people and guests (`g:<link id>` for a guest), as unrevealedDraws keeps them. */
export const giverKey = (c: Pick<Claim, 'giverId' | 'guestId'>): string | null => c.giverId ?? (c.guestId ? `g:${c.guestId}` : null);

function claimOf(db: Db, who: Giver, wishId: string): Claim | undefined {
  return db.select().from(t.claim).where(and(eq(t.claim.wishId, wishId), giverIs(who))).get();
}
function myClaim(db: Db, me: Person, wishId: string): Claim | undefined {
  return claimOf(db, { personId: me.id }, wishId);
}
function myShare(db: Db, me: Pick<Person, 'id'>, wishId: string): Share | undefined {
  return db.select().from(t.share).where(and(eq(t.share.wishId, wishId), eq(t.share.giverId, me.id))).get();
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
export function claimWish(db: Db, me: Person, wishId: string, quantity: number): Wish {
  return claimFor(db, giving(db, me, wishId), { personId: me.id }, quantity);
}
/** The same for any giver, on a wish already checked as theirs to give (giving(), or guests/guests.ts for a guest). */
export function claimFor(db: Db, w: Wish, who: Giver, quantity: number): Wish {
  listed(w);
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    if (groupOf(tx, w.id)) throw new Refused(409, 'it is a group gift: chip in instead');
    const claims = tx.select().from(t.claim).where(eq(t.claim.wishId, w.id)).all();
    const mine = claims.find((c) => isGivers(c, who));
    if (mine?.state === 'given') throw new Refused(409, 'you have given it already');
    const others = claims.filter((c) => c !== mine).reduce((n, c) => n + c.quantity, 0);
    if (others + quantity > w.quantity) throw new Refused(409, others >= w.quantity ? 'someone is getting it already' : 'not that many are left to claim');
    if (mine) tx.update(t.claim).set({ quantity, updatedAt: ts() }).where(eq(t.claim.id, mine.id)).run();
    else {
      tx.insert(t.claim).values({
        id: ulid(), wishId: w.id, giverId: 'personId' in who ? who.personId : null, guestId: 'guestId' in who ? who.guestId : null,
        quantity, state: 'claimed', createdAt: ts(), updatedAt: ts(),
      }).run();
    }
  });
  return w;
}

/** Bought, given (today), or back: a given gift its person has by now stays given. */
export function setClaimState(db: Db, me: Person, wishId: string, state: ClaimState, today: string): Wish {
  return setClaimStateFor(db, giving(db, me, wishId), { personId: me.id }, state, today);
}
export function setClaimStateFor(db: Db, w: Wish, who: Giver, state: ClaimState, today: string): Wish {
  const c = claimOf(db, who, w.id);
  if (!c) throw new Refused(404, 'you have not claimed it');
  if (c.state === state) return w;
  if (overNow(db, w, c, today)) throw new Refused(409, 'it was given, and its celebration is over');
  db.update(t.claim).set({ state, ...givenFields(db, w, state === 'given', today), named: 0, updatedAt: ts() }).where(eq(t.claim.id, c.id)).run();
  return w;
}

export function unclaimWish(db: Db, me: Person, wishId: string): void {
  unclaimFor(db, giving(db, me, wishId), { personId: me.id });
}
export function unclaimFor(db: Db, w: Wish, who: Giver): void {
  const c = claimOf(db, who, w.id);
  if (!c) throw new Refused(404, 'you have not claimed it');
  if (c.state === 'given') throw new Refused(409, 'it is given: mark it not given first');
  db.delete(t.claim).where(eq(t.claim.id, c.id)).run();
}

/**
 * An admin releases a wish's imported reservation (a Reserved row of the sheet whose buyer is nobody here, review L1).
 * Refused as any giving is first (the wish's person, kids: before a claim is read), then to anyone but an admin.
 */
export function releaseImported(db: Db, me: Person, wishId: string): Wish {
  const w = giving(db, me, wishId);
  if (me.role !== 'admin') throw new Refused(403, 'admins release an imported reservation');
  // A given one (the sheet's Given rows, ADR 0005) is the person's once revealed: released, it would come back to their
  // list and leave their thank-yous (Gate re-attack R3). Only a reservation nobody has given yet is released.
  const held = db.select().from(t.claim).where(and(eq(t.claim.wishId, w.id), eq(t.claim.imported, 1))).get();
  if (held && (held.state === 'given' || held.revealedOn !== null)) throw new Refused(409, 'it was given: the reservation stays');
  const gone = db.delete(t.claim).where(and(eq(t.claim.wishId, w.id), eq(t.claim.imported, 1))).run().changes;
  if (!gone) throw new Refused(404, 'no such reservation');
  db.insert(t.audit).values({ id: ulid(), at: ts(), actorId: me.id, action: 'reservation_released', subjectId: w.id }).run();
  return w;
}

/** Once its person has it, a giver puts their name on what they gave (or takes it off), so they can thank them. */
export function setNamed(db: Db, me: Person, wishId: string, named: boolean, today: string): Wish {
  const w = giving(db, me, wishId);
  const g = groupOf(db, w.id);
  const mine = g ? myShare(db, me, w.id) : myClaim(db, me, w.id);
  const given: Given | undefined = g ?? (mine as Claim | undefined);
  if (!mine || !given || !overNow(db, w, given, today)) throw new Refused(409, 'only for a gift you gave, once its celebration is over');
  const set = { named: named ? 1 : 0, updatedAt: ts() };
  if (g) db.update(t.share).set(set).where(eq(t.share.id, mine.id)).run();
  else db.update(t.claim).set(set).where(eq(t.claim.id, mine.id)).run();
  return w;
}

/** Makes a wish a group gift with a target (the household's currency first); not one somebody has claimed. */
export function startGroup(db: Db, me: Person, wishId: string, targetMinor: number): Wish {
  const w = giving(db, me, wishId);
  listed(w);
  if (!currency(db)) throw new Refused(409, 'the household has no currency yet: an admin sets it first');
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    if (groupOf(tx, w.id)) throw new Refused(409, 'it is a group gift already');
    if (tx.select({ id: t.claim.id }).from(t.claim).where(eq(t.claim.wishId, w.id)).get()) throw new Refused(409, 'someone is getting it already');
    tx.insert(t.groupGift).values({ wishId: w.id, organizerId: me.id, targetMinor, state: 'open', createdAt: ts(), updatedAt: ts() }).run();
  });
  return w;
}

/** Whoever started it runs it; if they have left the household, anyone who chipped in. */
export function managesGroup(db: Db, me: Pick<Person, 'id'>, g: GroupGift): boolean {
  if (g.organizerId) return g.organizerId === me.id;
  return Boolean(myShare(db, me, g.wishId));
}

export function editGroup(db: Db, me: Person, wishId: string, patch: { targetMinor?: number; state?: GroupState }, today: string, raised: (sharers: string[]) => void = () => {}): Wish {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (!managesGroup(db, me, g)) throw new Refused(403, 'whoever started the group gift changes it');
  if (patch.targetMinor !== undefined && g.state !== 'open') throw new Refused(409, 'it is bought: the target stays');
  // Any target until someone chips in: one refused for what is in would let the organizer find the total (Gate surprise
  // L3). Then it only goes up, and only by whoever started it (re-attack R1): moving it to and fro, "enough" flipping,
  // gave the total in a few tries.
  // And at most once a day, each raise told to the sharers (re-attack 2, Q3): raising it a franc at a time until
  // "enough" turned false gave the total in a dozen tries.
  const sharers = db.select({ giverId: t.share.giverId }).from(t.share).where(eq(t.share.wishId, w.id)).all();
  const raising = patch.targetMinor !== undefined && patch.targetMinor !== g.targetMinor && sharers.length > 0;
  if (raising) {
    if (g.organizerId !== me.id || patch.targetMinor! < g.targetMinor) throw new Refused(409, 'someone has chipped in: only whoever started it raises the target');
    if (g.raisedOn === today) throw new Refused(409, 'the target went up today already: again tomorrow');
  }
  const state = patch.state ?? g.state;
  if (state !== g.state && overNow(db, w, g, today)) throw new Refused(409, 'it was given, and its celebration is over');
  const dates = state === g.state ? {} : givenFields(db, w, state === 'given', today);
  db.transaction((tx) => {
    tx.update(t.groupGift).set({ targetMinor: patch.targetMinor ?? g.targetMinor, state, ...dates, ...(raising ? { raisedOn: today } : {}), updatedAt: ts() }).where(eq(t.groupGift.wishId, w.id)).run();
    if (raising) raised(sharers.map((x) => x.giverId).filter((id): id is string => id !== null && id !== me.id));
    if (state !== g.state) tx.update(t.share).set({ named: 0 }).where(eq(t.share.wishId, w.id)).run();
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

/**
 * How many times a day one giver chips in, changes or takes back their share of one gift (Gate re-attack R1): searching
 * their own share for the point where "enough" flips found the others' amount in 14 tries; at 3 a day that takes
 * weeks, by which time the gift is bought. Accepted as a slow oracle (ADR 0003).
 */
export const SHARE_CHANGES_A_DAY = 3;
function countShareChange(db: Db, me: Person, wishId: string, today: string): void {
  const row = db.select().from(t.shareChange).where(and(eq(t.shareChange.wishId, wishId), eq(t.shareChange.giverId, me.id))).get();
  const changes = row && row.day === today ? row.changes : 0;
  if (changes >= SHARE_CHANGES_A_DAY) throw new Refused(409, 'you changed your share 3 times today: again tomorrow');
  db.insert(t.shareChange).values({ wishId, giverId: me.id, day: today, changes: changes + 1 })
    .onConflictDoUpdate({ target: [t.shareChange.wishId, t.shareChange.giverId], set: { day: today, changes: changes + 1 } }).run();
}

/** Chips in (or changes your share) while the group gift is open, up to its target all together. */
export function chipIn(db: Db, me: Person, wishId: string, amountMinor: number, today: string): Wish {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (g.state !== 'open') throw new Refused(409, 'it is bought: shares stay as they are');
  // A share alone within the target; the shares together may go past it ("enough"): a refusal for what others put in
  // would let a giver find their amounts (Gate surprise L3).
  if (amountMinor > g.targetMinor) throw new Refused(409, 'that would go over the target');
  const mine = myShare(db, me, w.id);
  if (mine?.amountMinor === amountMinor) return w;
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    countShareChange(tx, me, w.id, today);
    if (mine) tx.update(t.share).set({ amountMinor, updatedAt: ts() }).where(eq(t.share.id, mine.id)).run();
    else tx.insert(t.share).values({ id: ulid(), wishId: w.id, giverId: me.id, amountMinor, createdAt: ts(), updatedAt: ts() }).run();
  });
  return w;
}

export function withdrawShare(db: Db, me: Person, wishId: string, today: string): void {
  const w = giving(db, me, wishId);
  const g = mustGroup(db, w.id);
  if (g.state !== 'open') throw new Refused(409, 'it is bought: shares stay as they are');
  const mine = myShare(db, me, w.id);
  if (!mine) throw new Refused(404, 'you have not chipped in');
  db.transaction((tx0) => {
    const tx = asDb(tx0);
    countShareChange(tx, me, w.id, today);
    tx.delete(t.share).where(eq(t.share.id, mine.id)).run();
  });
}
