// Ideas (spec §3): a grown-up keeps gift ideas for a person, shared with the other givers. Never for the person
// themselves and never for a kid (kids see no gifts at all, PR #8): the view layer reads ideas only for a viewer who
// `seesIdeas`, so the person's and a kid's answers are the same whatever ideas exist. Every refusal to them is decided
// from the caller and the person alone, before any idea is read.
import { and, count, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { randomId } from '../auth/tokens';
import { Refused } from '../errors';
import { mustGetPerson, type Person } from '../household/people';

export type Idea = typeof t.idea.$inferSelect;
export const MAX_IDEAS = 50; // the message says it

/** Who sees ideas for a person: grown-ups other than the person. */
export const seesIdeas = (me: Pick<Person, 'id' | 'role'>, personId: string) => me.role !== 'kid' && me.id !== personId;

export function ideasFor(db: Db, personIds: string[]): Idea[] {
  return personIds.length ? db.select().from(t.idea).where(inArray(t.idea.personId, personIds)).all() : [];
}

export function addIdea(db: Db, me: Person, personId: string, text: string): string {
  const p = mustGetPerson(db, personId);
  if (me.id === p.id) throw new Refused(403, 'ideas are kept by others, for you');
  if (me.role === 'kid') throw new Refused(403, 'grown-ups keep ideas');
  if ((db.select({ n: count() }).from(t.idea).where(eq(t.idea.personId, p.id)).get()?.n ?? 0) >= MAX_IDEAS) {
    throw new Refused(409, 'at most 50 ideas for one person');
  }
  // Random, not a ULID: an id carries no moment (review L4).
  const id = randomId();
  db.insert(t.idea).values({ id, personId: p.id, authorId: me.id, text: text.trim(), createdAt: new Date().toISOString() }).run();
  return id;
}

/** Its author or an admin removes it; for the person themselves and for kids it does not exist (404). */
export function removeIdea(db: Db, me: Person, id: string): string {
  const i = db.select().from(t.idea).where(eq(t.idea.id, id)).get();
  if (!i || !seesIdeas(me, i.personId)) throw new Refused(404, 'no such idea');
  if (i.authorId !== me.id && me.role !== 'admin') throw new Refused(403, 'only whoever wrote it removes an idea');
  db.delete(t.idea).where(and(eq(t.idea.id, i.id))).run();
  return i.personId;
}

export const getIdea = (db: Db, id: string): Idea | undefined => db.select().from(t.idea).where(eq(t.idea.id, id)).get();
