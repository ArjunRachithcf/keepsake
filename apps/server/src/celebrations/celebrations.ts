// Celebrations (spec §3, ADR 0007): household objects with a date, place, poster and people. Adults host them; the
// host or an admin changes them. The draw (M3) is not here yet.
import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import type { Person } from '../household/people';

export type Celebration = typeof t.celebration.$inferSelect;
export const POSTERS = ['pine', 'berry', 'night', 'gold'] as const;
export type Poster = (typeof POSTERS)[number];

export interface CelebrationInput {
  name: string; date: string; place: string | null; poster: Poster; recurrence: 'none' | 'yearly'; people: string[];
}

export function allCelebrations(db: Db): Celebration[] {
  return db.select().from(t.celebration).all();
}

export function getCelebration(db: Db, id: string): Celebration | undefined {
  return db.select().from(t.celebration).where(eq(t.celebration.id, id)).get();
}

export function mustGetCelebration(db: Db, id: string): Celebration {
  const c = getCelebration(db, id);
  if (!c) throw new Refused(404, 'no such celebration');
  return c;
}

export function peopleOf(db: Db, celebrationId: string): string[] {
  return db.select({ id: t.celebrationPerson.personId }).from(t.celebrationPerson).where(eq(t.celebrationPerson.celebrationId, celebrationId)).all().map((r) => r.id);
}

/** Every celebration's people, at once. */
export function peopleByCelebration(db: Db): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of db.select().from(t.celebrationPerson).all()) m.set(r.celebrationId, [...(m.get(r.celebrationId) ?? []), r.personId]);
  return m;
}

/** The celebrations a person is part of. */
export function celebrationsOfPerson(db: Db, personId: string): Celebration[] {
  return db.select({ c: t.celebration }).from(t.celebration).innerJoin(t.celebrationPerson, eq(t.celebrationPerson.celebrationId, t.celebration.id))
    .where(eq(t.celebrationPerson.personId, personId)).all().map((r) => r.c);
}

export function isIn(db: Db, celebrationId: string, personId: string): boolean {
  return Boolean(db.select().from(t.celebrationPerson)
    .where(and(eq(t.celebrationPerson.celebrationId, celebrationId), eq(t.celebrationPerson.personId, personId))).get());
}

function checkPeople(db: Db, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new Refused(400, 'people: at least one person');
  const found = db.select({ id: t.person.id }).from(t.person).where(inArray(t.person.id, unique)).all();
  if (found.length !== unique.length) throw new Refused(400, 'people: someone is not in the household');
  return unique;
}

/** Hosting is for adults; changing a celebration is for its host and the admins. */
export function canChange(me: Pick<Person, 'id' | 'role'>, c: Pick<Celebration, 'hostId'>): boolean {
  return me.role === 'admin' || (me.role === 'adult' && c.hostId === me.id);
}

/** A grown-up hosts at most this many celebrations (Gate routes, Info: as wishes, links, ideas and guests are capped). */
export const MAX_HOSTED = 100; // the message says it

export function addCelebration(db: Db, me: Person, i: CelebrationInput): Celebration {
  if (me.role === 'kid') throw new Refused(403, 'grown-ups host celebrations');
  const hosted = db.select({ id: t.celebration.id }).from(t.celebration).where(eq(t.celebration.hostId, me.id)).all().length;
  if (hosted >= MAX_HOSTED) throw new Refused(409, 'at most 100 celebrations for one host');
  const people = checkPeople(db, i.people);
  const id = ulid();
  db.transaction((tx) => {
    tx.insert(t.celebration).values({ id, name: i.name.trim(), date: i.date, place: i.place?.trim() || null, poster: i.poster, recurrence: i.recurrence, hostId: me.id, createdAt: new Date().toISOString() }).run();
    for (const p of people) tx.insert(t.celebrationPerson).values({ celebrationId: id, personId: p }).run();
  });
  return getCelebration(db, id)!;
}

export function editCelebration(db: Db, me: Person, id: string, patch: Partial<CelebrationInput>): Celebration {
  const c = mustGetCelebration(db, id);
  if (!canChange(me, c)) throw new Refused(403, 'only its host or an admin changes a celebration');
  const people = patch.people ? checkPeople(db, patch.people) : null;
  db.transaction((tx) => {
    tx.update(t.celebration).set({
      name: patch.name?.trim() ?? c.name,
      date: patch.date ?? c.date,
      place: patch.place === undefined ? c.place : patch.place?.trim() || null,
      poster: patch.poster ?? c.poster,
      recurrence: patch.recurrence ?? c.recurrence,
    }).where(eq(t.celebration.id, id)).run();
    if (people) {
      tx.delete(t.celebrationPerson).where(eq(t.celebrationPerson.celebrationId, id)).run();
      for (const p of people) tx.insert(t.celebrationPerson).values({ celebrationId: id, personId: p }).run();
      // Someone no longer in it keeps their wishes for it, now for any time (ADR 0007: moving keeps everything else).
      tx.update(t.wish).set({ celebrationId: null }).where(and(eq(t.wish.celebrationId, id), notInArray(t.wish.personId, people))).run();
    }
  });
  return getCelebration(db, id)!;
}

/** Its wishes stay, for any time (the foreign key sets them free). */
export function removeCelebration(db: Db, me: Person, id: string): void {
  const c = mustGetCelebration(db, id);
  if (!canChange(me, c)) throw new Refused(403, 'only its host or an admin removes a celebration');
  db.delete(t.celebration).where(eq(t.celebration.id, id)).run();
}

/**
 * ADR 0007: once a one-off celebration's day has passed, its wishes are for any time, given or not (the wish's row
 * never depends on its gifts, ADR 0003); `was_for` remembers that day's celebration, so a late gift still counts for it
 * (gifts/gifts.ts). Yearly ones roll on to their next date and keep theirs. `today` is the household's day. Returns
 * whether any wish moved.
 */
export function settlePastCelebrations(db: Db, today: string): boolean {
  const past = db.select({ id: t.celebration.id }).from(t.celebration).where(and(eq(t.celebration.recurrence, 'none'), lt(t.celebration.date, today))).all().map((c) => c.id);
  return past.length > 0 && db.update(t.wish).set({ wasFor: sql`${t.wish.celebrationId}`, celebrationId: null }).where(inArray(t.wish.celebrationId, past)).run().changes > 0;
}
