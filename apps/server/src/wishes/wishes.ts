// Wishes (spec §3, ADR 0007): a wish belongs to its person and is for one celebration or any time. Who may see one is
// decided here (`canSee`) and applied by the view layer before anything is counted, filtered or sorted (ADR 0003).
//
// - The person adds their own: listed at once, except a kid's, which waits for a manager (awaiting_parent).
// - A kid's manager adds one for the kid: listed.
// - Anyone else adds one for someone: a suggestion, which the person (or a kid's manager) approves or declines.
//   A kid's approval of a suggestion still waits for a manager.
// - A kid's change to a listed wish of theirs sends it back to their manager.
import { and, count, eq, inArray, max } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { isIn } from '../celebrations/celebrations';
import { currency, getPerson, keeps, managesKid, mustGetPerson, type Person } from '../household/people';

export type Wish = typeof t.wish.$inferSelect;
export type WishState = Wish['state'];

export interface WishInput {
  name: string; link: string | null; priceMinor: number | null; quantity: number; note: string | null;
  mostWanted: boolean; celebrationId: string | null;
}

/** Who may see a wish (before any claim exists; claims come with M2 and are cut in the view layer). */
export function canSee(db: Db, me: Person, w: Wish): boolean {
  if (w.state === 'listed') return true;
  const owner = getPerson(db, w.personId);
  if (!owner) return false;
  if (w.state === 'awaiting_parent') return keeps(db, me, owner);
  return w.addedBy === me.id || keeps(db, me, owner); // suggested
}

/** May change or remove it: whoever keeps the person's list; the one who suggested it, while it is a suggestion. */
export function canEdit(db: Db, me: Person, w: Wish): boolean {
  const owner = getPerson(db, w.personId);
  if (!owner) return false;
  if (w.state === 'suggested') return w.addedBy === me.id;
  return keeps(db, me, owner);
}

/** May approve or decline it: a suggestion's person or a kid's manager; a kid's waiting wish, its manager. */
export function canApprove(db: Db, me: Person, w: Wish): boolean {
  const owner = getPerson(db, w.personId);
  if (!owner) return false;
  if (w.state === 'suggested') return w.addedBy !== me.id && keeps(db, me, owner);
  if (w.state === 'awaiting_parent') return managesKid(db, me, owner);
  return false;
}

export function getWish(db: Db, id: string): Wish | undefined {
  return db.select().from(t.wish).where(eq(t.wish.id, id)).get();
}

/** A wish the caller may see, or 404 (one answer whether it exists or is hidden). */
export function seeWish(db: Db, me: Person, id: string): Wish {
  const w = getWish(db, id);
  if (!w || !canSee(db, me, w)) throw new Refused(404, 'no such wish');
  return w;
}

export function wishesOf(db: Db, personIds: string[]): Wish[] {
  return personIds.length ? db.select().from(t.wish).where(inArray(t.wish.personId, personIds)).all() : [];
}

export function wishesAddedBy(db: Db, personId: string, state: WishState): Wish[] {
  return db.select().from(t.wish).where(and(eq(t.wish.addedBy, personId), eq(t.wish.state, state))).all();
}

export function allWaiting(db: Db): Wish[] {
  return db.select().from(t.wish).where(inArray(t.wish.state, ['awaiting_parent', 'suggested'])).all();
}

function checkFor(db: Db, personId: string, celebrationId: string | null): void {
  if (celebrationId !== null && !isIn(db, celebrationId, personId)) throw new Refused(400, 'celebrationId: a celebration this person is part of, or null for any time');
}

function checkPrice(db: Db, priceMinor: number | null): void {
  if (priceMinor !== null && !currency(db)) throw new Refused(409, 'the household has no currency yet: an admin sets it first');
}

/** At most this many wishes on a person's list (listed and waiting), and this many of one person's suggestions waiting for another. */
export const MAX_WISHES = 300;
export const MAX_SUGGESTIONS = 30;

function onList(db: Db, personId: string): number {
  return db.select({ n: count() }).from(t.wish).where(and(eq(t.wish.personId, personId), inArray(t.wish.state, ['listed', 'awaiting_parent']))).get()?.n ?? 0;
}
function checkRoom(db: Db, personId: string): void {
  if (onList(db, personId) >= MAX_WISHES) throw new Refused(409, `a list holds at most ${MAX_WISHES} wishes`);
}

const nextPosition = (db: Db, personId: string) =>
  (db.select({ p: max(t.wish.position) }).from(t.wish).where(eq(t.wish.personId, personId)).get()?.p ?? -1) + 1;

export function addWish(db: Db, me: Person, personId: string, i: WishInput): Wish {
  const owner = mustGetPerson(db, personId);
  checkFor(db, owner.id, i.celebrationId);
  checkPrice(db, i.priceMinor);
  const state: WishState = owner.id === me.id ? (me.role === 'kid' ? 'awaiting_parent' : 'listed')
    : managesKid(db, me, owner) ? 'listed' : 'suggested';
  if (state === 'suggested') {
    const waiting = db.select({ n: count() }).from(t.wish)
      .where(and(eq(t.wish.personId, owner.id), eq(t.wish.addedBy, me.id), eq(t.wish.state, 'suggested'))).get()?.n ?? 0;
    if (waiting >= MAX_SUGGESTIONS) throw new Refused(409, `at most ${MAX_SUGGESTIONS} suggestions wait for one person`);
  } else checkRoom(db, owner.id);
  const now = new Date().toISOString();
  const id = ulid();
  db.insert(t.wish).values({
    id, personId: owner.id, celebrationId: i.celebrationId, name: i.name.trim(), link: i.link, priceMinor: i.priceMinor,
    quantity: i.quantity, note: i.note?.trim() || null, mostWanted: i.mostWanted ? 1 : 0, position: nextPosition(db, owner.id),
    state, addedBy: me.id, createdAt: now, updatedAt: now,
  }).run();
  return getWish(db, id)!;
}

export function editWish(db: Db, me: Person, id: string, patch: Partial<WishInput>): Wish {
  const w = seeWish(db, me, id);
  if (!canEdit(db, me, w)) throw new Refused(403, 'this wish is not yours to change');
  const celebrationId = patch.celebrationId === undefined ? w.celebrationId : patch.celebrationId;
  if (patch.celebrationId !== undefined) checkFor(db, w.personId, celebrationId);
  if (patch.priceMinor !== undefined) checkPrice(db, patch.priceMinor);
  // A kid's change to a listed wish goes back to a manager before others see it again.
  const state: WishState = w.state === 'listed' && me.role === 'kid' && me.id === w.personId ? 'awaiting_parent' : w.state;
  db.update(t.wish).set({
    name: patch.name?.trim() ?? w.name,
    link: patch.link === undefined ? w.link : patch.link,
    priceMinor: patch.priceMinor === undefined ? w.priceMinor : patch.priceMinor,
    quantity: patch.quantity ?? w.quantity,
    note: patch.note === undefined ? w.note : patch.note?.trim() || null,
    mostWanted: patch.mostWanted === undefined ? w.mostWanted : patch.mostWanted ? 1 : 0,
    celebrationId, state, updatedAt: new Date().toISOString(),
  }).where(eq(t.wish.id, id)).run();
  return getWish(db, id)!;
}

export function removeWish(db: Db, me: Person, id: string): void {
  const w = seeWish(db, me, id);
  if (!canEdit(db, me, w)) throw new Refused(403, 'this wish is not yours to remove');
  db.delete(t.wish).where(eq(t.wish.id, id)).run();
}

export function approveWish(db: Db, me: Person, id: string): Wish {
  const w = seeWish(db, me, id);
  if (!canApprove(db, me, w)) throw new Refused(403, 'this wish is not yours to approve');
  const owner = mustGetPerson(db, w.personId);
  if (w.state === 'suggested') checkRoom(db, owner.id);
  // A kid saying yes to a suggestion still needs a manager's yes; a manager's yes lists it.
  const state: WishState = w.state === 'suggested' && owner.role === 'kid' && me.id === owner.id ? 'awaiting_parent' : 'listed';
  db.update(t.wish).set({ state, updatedAt: new Date().toISOString() }).where(eq(t.wish.id, id)).run();
  return getWish(db, id)!;
}

/** A declined suggestion or a kid's declined wish is gone. */
export function declineWish(db: Db, me: Person, id: string): void {
  const w = seeWish(db, me, id);
  if (!canApprove(db, me, w)) throw new Refused(403, 'this wish is not yours to decline');
  db.delete(t.wish).where(eq(t.wish.id, id)).run();
}

/** A person's own order: exactly their listed and waiting wishes (suggestions are not on the list yet). */
export function orderWishes(db: Db, me: Person, personId: string, ids: string[]): void {
  const owner = mustGetPerson(db, personId);
  if (!keeps(db, me, owner)) throw new Refused(403, 'only the person (or a kid\'s manager) orders their wishes');
  const mine = db.select({ id: t.wish.id }).from(t.wish)
    .where(and(eq(t.wish.personId, owner.id), inArray(t.wish.state, ['listed', 'awaiting_parent']))).all().map((r) => r.id);
  if (ids.length !== mine.length || new Set(ids).size !== ids.length || !ids.every((x) => mine.includes(x))) {
    throw new Refused(400, 'wishIds: each of the person\'s wishes once');
  }
  db.transaction((tx) => ids.forEach((wid, i) => tx.update(t.wish).set({ position: i }).where(eq(t.wish.id, wid)).run()));
}
