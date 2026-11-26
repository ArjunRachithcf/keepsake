// What is new for a person (ADR 0010): in the app, and by a Web Push that says only "Something new in Keepsake".
//
// A notice is a pointer: its kind and what it is about (a celebration, a question, a thank-you), never its content.
// The view layer builds each from what its person may see when they read it, through the same rules as every other
// answer, and drops one that no longer points at anything they may see.
//
// Only things the person may know make a notice, so neither the notices nor the pushes (whether one comes, when)
// follow a gift, an idea, a question on its way or its asker, someone else's reminder, or whom anyone drew:
// - `question`: a question reached its person at the morning batch (a kid's: their parents);
// - `answered`: the person answered the caller's question (or would rather not say);
// - `draw`: names were drawn, drawn again, or the draw went back to not drawn, for its people;
// - `remind`: a celebration is coming (theirs, a week before; or someone's they asked "Remind me" about);
// - `reveal`: a draw's reveal date has come, for its people and its host;
// - `say_thanks`: gifts reached their person (after the celebration, as `GET /home` `thanks` shows them);
// - `thanked`: someone thanked the caller for a gift the caller gave.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';

export type Notice = typeof t.notice.$inferSelect;
export type NoticeKind = Notice['kind'];

/** One id per (person, kind, subject, day): the same notice is made once, however often the batch runs. */
export const noticeId = (personId: string, kind: NoticeKind, subjectId: string, day: string) =>
  createHash('sha256').update(`keepsake-notice:v1:${personId}:${kind}:${subjectId}:${day}`).digest('base64url').slice(0, 22);

/** At most this many notices are listed, and none older than this many days are kept. */
export const MAX_LISTED = 100;
export const KEEP_DAYS = 120;

/**
 * Tells these people about one thing. Returns those it was new for (only they get a push). `day`: the day of the
 * thing itself (when the question arrived, the celebration's reminder day), so a batch run again later finds it made.
 */
export function tell(db: Db, personIds: Iterable<string>, kind: NoticeKind, subjectId: string, day: string, o: { aboutId?: string | null; again?: boolean } = {}): string[] {
  const told: string[] = [];
  for (const personId of new Set(personIds)) {
    const q = db.insert(t.notice).values({ id: noticeId(personId, kind, subjectId, day), personId, kind, subjectId, aboutId: o.aboutId ?? null, day });
    // `again`: a draw drawn again the same day is news again (unread, and a push).
    const r = o.again ? q.onConflictDoUpdate({ target: t.notice.id, set: { readAt: null } }).run() : q.onConflictDoNothing().run();
    if (r.changes) told.push(personId);
  }
  return told;
}

export function noticesOf(db: Db, personId: string): Notice[] {
  return db.select().from(t.notice).where(eq(t.notice.personId, personId)).orderBy(desc(t.notice.day), t.notice.id).limit(MAX_LISTED).all();
}

/** The caller has seen their notices. */
export function markRead(db: Db, personId: string, now = new Date()): void {
  db.update(t.notice).set({ readAt: now.toISOString() }).where(and(eq(t.notice.personId, personId), isNull(t.notice.readAt))).run();
}

export function pruneNotices(db: Db, oldest: string): void {
  db.delete(t.notice).where(lt(t.notice.day, oldest)).run();
}

/** Drawn, drawn again, or back to not drawn: one stamp per draw, compared before and after a change (data.ts). */
export type DrawStamps = Map<string, string>;
export function drawStamps(db: Db): DrawStamps {
  return new Map(db.select({ id: t.draw.id, drawnAt: t.draw.drawnAt, redrawnAt: t.draw.redrawnAt }).from(t.draw).all()
    .map((d) => [d.id, `${d.drawnAt ?? ''}|${d.redrawnAt ?? ''}`]));
}
/**
 * The draws whose names were drawn, drawn again or cleared between two stamps, with their people (persons only:
 * guests have no notices) and celebration. A draw that went entirely tells nobody.
 */
export function drawsChanged(db: Db, before: DrawStamps): { celebrationId: string; people: string[] }[] {
  const after = drawStamps(db);
  const ids = [...after].filter(([id, s]) => (before.get(id) ?? '|') !== s).map(([id]) => id);
  if (!ids.length) return [];
  const draws = db.select({ id: t.draw.id, celebrationId: t.draw.celebrationId }).from(t.draw).where(inArray(t.draw.id, ids)).all();
  const ps = db.select({ drawId: t.drawParticipant.drawId, personId: t.drawParticipant.personId }).from(t.drawParticipant)
    .where(and(inArray(t.drawParticipant.drawId, ids), eq(t.drawParticipant.kind, 'person'))).all();
  return draws.map((d) => ({ celebrationId: d.celebrationId, people: ps.filter((p) => p.drawId === d.id && p.personId).map((p) => p.personId!) }));
}
