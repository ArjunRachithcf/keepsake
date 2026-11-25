// Anonymous questions (spec §3, ADR 0008): a giver asks a person one question about their wishes; one answer, no chat.
//
// - The asker is kept (so they find theirs and so the limits hold) but nothing here returns it: `isAsker` compares it
//   with the caller and says yes or no, and only the view layer asks (for "yours"), never for anyone but the caller.
// - Delivery: 08:00 household time on the day after it was asked (`deliveryOf`), computed when read. Until then only
//   its asker sees it, so when a question shows up says nothing about who was online. Ids are random, not ULIDs, so
//   no id carries the moment it was asked.
// - Who asks: grown-ups (not the person, not a kid's own parent: they keep the kid's list) and guests with a link to
//   the person. A question to a kid goes to the kid's parents, who answer it (the kid does not see questions).
// - Who sees it once delivered: the person (to answer), and everyone giving to them (grown-ups, guests with a link to
//   them), without its asker; its asker sees theirs marked "yours". A declined one only its asker.
// - Admins remove an abusive one; that says nothing about the asker either (audited as who removed which question).
import { and, count, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { randomId } from '../auth/tokens';
import { addDays, atHour, today } from '../celebrations/dates';
import { Refused } from '../errors';
import { getPerson, managesKid, mustGetPerson, type Person } from '../household/people';
import { addWish, type WishInput } from '../wishes/wishes';

export type Question = typeof t.question.$inferSelect;
/** Who asks: someone of the household, or a guest (their link). */
export type Asker = { personId: string } | { guestId: string };

/** Open questions one asker may have waiting for one person, and one person may have waiting in all. */
export const MAX_OPEN_PER_ASKER = 3; // the messages say these numbers
export const MAX_OPEN_PER_PERSON = 30;
export const BATCH_HOUR = 8;

/** When a question asked at `at` reaches its person: 08:00 household time the next day. */
export const deliveryOf = (at: Date, timeZone: string): Date => atHour(addDays(today(timeZone, at), 1), BATCH_HOUR, timeZone);
export const isDelivered = (q: Pick<Question, 'deliverAt'>, now: Date) => q.deliverAt <= now.toISOString();
/** Whether the caller asked it. The only reading of the asker, and it answers only about the caller. */
export const isAsker = (q: Pick<Question, 'askerId' | 'askerGuestId'>, who: Asker) =>
  'personId' in who ? q.askerId !== null && q.askerId === who.personId : q.askerGuestId !== null && q.askerGuestId === who.guestId;

/** Who answers a person's questions: the person (a grown-up), or a kid's parents. */
export function answersFor(db: Db, me: Pick<Person, 'id' | 'role'>, person: Pick<Person, 'id' | 'role'>): boolean {
  return person.role === 'kid' ? managesKid(db, me, person) : me.id === person.id;
}
/** Who sees a person's delivered questions as a giver: grown-ups other than the person. */
export const givesTo = (me: Pick<Person, 'id' | 'role'>, personId: string) => me.role !== 'kid' && me.id !== personId;

/** What a household viewer may see of a question: theirs always; once delivered, the answerers' and givers' (not a declined one). */
export function seesQuestion(db: Db, me: Person, q: Question, now: Date): boolean {
  if (isAsker(q, { personId: me.id })) return true;
  if (!isDelivered(q, now)) return false;
  const p = getPerson(db, q.personId);
  if (!p) return false;
  if (answersFor(db, me, p)) return q.state === 'open' || q.state === 'answered';
  return q.state === 'answered' || (q.state === 'open' && givesTo(me, p.id));
}

export function questionsFor(db: Db, personIds: string[]): Question[] {
  return personIds.length ? db.select().from(t.question).where(inArray(t.question.personId, personIds)).all() : [];
}

/** Asks a person a question. Returns its id. */
export function ask(db: Db, timeZone: string, who: Asker & { role?: Person['role'] }, personId: string, text: string, now = new Date()): string {
  const p = mustGetPerson(db, personId);
  if ('personId' in who) {
    if (who.role === 'kid') throw new Refused(403, 'grown-ups and guests ask questions');
    if (who.personId === p.id) throw new Refused(403, 'your own wishes are for others to ask about');
    if (managesKid(db, { id: who.personId, role: who.role ?? 'adult' }, p)) throw new Refused(403, 'you keep their list: you know it already');
  }
  const open = and(eq(t.question.personId, p.id), eq(t.question.state, 'open'));
  const mine = 'personId' in who ? eq(t.question.askerId, who.personId) : eq(t.question.askerGuestId, who.guestId);
  if ((db.select({ n: count() }).from(t.question).where(and(open, mine)).get()?.n ?? 0) >= MAX_OPEN_PER_ASKER) {
    throw new Refused(409, 'you have 3 questions waiting for them: wait for an answer');
  }
  if ((db.select({ n: count() }).from(t.question).where(open).get()?.n ?? 0) >= MAX_OPEN_PER_PERSON) {
    throw new Refused(409, 'they have many questions waiting: try again later');
  }
  const id = randomId();
  db.insert(t.question).values({
    id, personId: p.id, askerId: 'personId' in who ? who.personId : null, askerGuestId: 'guestId' in who ? who.guestId : null,
    text: text.trim(), askedAt: now.toISOString(), deliverAt: deliveryOf(now, timeZone).toISOString(), state: 'open',
  }).run();
  return id;
}

const get = (db: Db, id: string) => db.select().from(t.question).where(eq(t.question.id, id)).get();

/** A delivered, open question the caller answers (the person, a kid's parent); 404 for one they cannot see. */
function answerable(db: Db, me: Person, id: string, now: Date): Question {
  const q = get(db, id);
  if (!q || !seesQuestion(db, me, q, now)) throw new Refused(404, 'no such question');
  const p = mustGetPerson(db, q.personId);
  if (!isDelivered(q, now) || !answersFor(db, me, p)) throw new Refused(403, 'only they answer their questions');
  if (q.state !== 'open') throw new Refused(409, 'it is answered already');
  return q;
}

export function answerQuestion(db: Db, me: Person, id: string, text: string, now = new Date()): string {
  const q = answerable(db, me, id, now);
  db.update(t.question).set({ state: 'answered', answer: text.trim(), answeredAt: now.toISOString() }).where(eq(t.question.id, q.id)).run();
  return q.personId;
}

export function declineQuestion(db: Db, me: Person, id: string, now = new Date()): string {
  const q = answerable(db, me, id, now);
  db.update(t.question).set({ state: 'declined', answeredAt: now.toISOString() }).where(eq(t.question.id, q.id)).run();
  return q.personId;
}

/** "Add a wish instead": the wish joins their list (as the person or a kid's parent adds it) and answers the question. */
export function answerWithWish(db: Db, me: Person, id: string, i: WishInput, now = new Date()): string {
  const q = answerable(db, me, id, now);
  return db.transaction((tx0) => {
    const tx = asDb(tx0);
    const w = addWish(tx, me, q.personId, i);
    tx.update(t.question).set({ state: 'answered', answerWishId: w.id, answeredAt: now.toISOString() }).where(eq(t.question.id, q.id)).run();
    return w.id;
  });
}

/**
 * Its asker takes it back before it is delivered; an admin removes one they can see (abuse). Anyone else who can see
 * it gets a 403, anyone who cannot a 404. An admin's removal is audited (who removed which question, never who asked).
 */
export function removeQuestion(db: Db, me: Person, id: string, now = new Date()): void {
  const q = get(db, id);
  if (!q || !seesQuestion(db, me, q, now)) throw new Refused(404, 'no such question');
  const mine = isAsker(q, { personId: me.id });
  if (mine && !isDelivered(q, now)) {
    db.delete(t.question).where(eq(t.question.id, q.id)).run();
    return;
  }
  if (me.role !== 'admin') throw new Refused(mine ? 409 : 403, mine ? 'it has reached them: it stays' : 'admins remove questions');
  db.transaction((tx) => {
    tx.delete(t.question).where(eq(t.question.id, q.id)).run();
    tx.insert(t.audit).values({ id: ulid(), at: now.toISOString(), actorId: me.id, action: 'question_removed', subjectId: q.id }).run();
  });
}


export const getQuestion = (db: Db, id: string): Question | undefined => get(db, id);
