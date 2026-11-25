// Thank-yous (spec §3, ADR 0010): after a gift reaches its person, the person (or a kid's parent, who helps) writes
// one thank-you for it, and every giver of it in the household reads it, named or not. Who they are is never sent to
// the writer: the writer's answer is the same whoever gave and however many did (test/thanks.test.ts). Only a gift in
// the writer's `thanks` (gifts/gifts.ts thanksFor: received, the occasion over) can be thanked for, so a thank-you
// can never be written, or refused, in a way that tells whether something was given before its person may know.
import { eq, inArray } from 'drizzle-orm';
import { randomId } from '../auth/tokens';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { revealed, thanksFor } from '../gifts/gifts';
import type { Person } from '../household/people';

export type ThankYou = typeof t.thankYou.$inferSelect;
export const MAX_TEXT = 500;

/** The household givers of a received gift (never the writer, nor whoever left: their gifts stay unnamed). */
function giversOf(db: Db, wishId: string, today: string): string[] {
  const o = revealed(db, today).over.find((x) => x.wishId === wishId);
  return o ? [...new Set(o.givers.map((g) => g.giverId).filter((g): g is string => g !== null))] : [];
}

/**
 * Who a thank-you goes to: the household givers of its gift but its writer. Worked out in the push queue (ADR 0010,
 * PR #12 review L6), never in the writer's request: the request does the same work whoever gave.
 */
export function thankRecipients(db: Db, thankYouId: string, today: string): string[] {
  const x = getThankYou(db, thankYouId);
  return x ? giversOf(db, x.wishId, today).filter((g) => g !== x.writtenBy) : [];
}

/**
 * Writes the thank-you for one of the caller's received gifts (a kid's parent: for the kid's). Returns its id. A gift
 * that is not in the caller's thank-yous is a 404, as for none.
 */
export function writeThanks(db: Db, me: Person, wishId: string, text: string, today: string): string {
  if (!thanksFor(db, me, today).some((x) => x.wishId === wishId)) throw new Refused(404, 'no such wish');
  if (db.select().from(t.thankYou).where(eq(t.thankYou.wishId, wishId)).get()) throw new Refused(409, 'it is thanked for already');
  const id = randomId();
  db.insert(t.thankYou).values({ id, wishId, writtenBy: me.id, text: text.trim(), day: today }).run();
  return id;
}

export function thankYouFor(db: Db, wishIds: string[]): Map<string, ThankYou> {
  if (!wishIds.length) return new Map();
  return new Map(db.select().from(t.thankYou).where(inArray(t.thankYou.wishId, wishIds)).all().map((x) => [x.wishId, x]));
}

/** The thank-yous for gifts the viewer gave (not ones they wrote themselves), newest first. */
export function thankedBy(db: Db, viewerId: string, today: string): (ThankYou & { personId: string })[] {
  const mine = revealed(db, today).over.filter((o) => o.givers.some((g) => g.giverId === viewerId));
  const byWish = thankYouFor(db, mine.map((o) => o.wishId));
  return mine.flatMap((o) => {
    const x = byWish.get(o.wishId);
    return x && x.writtenBy !== viewerId ? [{ ...x, personId: o.personId }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day) || a.id.localeCompare(b.id)).slice(0, 100);
}

export function getThankYou(db: Db, id: string): ThankYou | undefined {
  return db.select().from(t.thankYou).where(eq(t.thankYou.id, id)).get();
}
