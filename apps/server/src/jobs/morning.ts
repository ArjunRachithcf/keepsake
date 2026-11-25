// The morning batch (ADR 0008, 0010): once a day at 08:00 household time, for everyone at once, so when a notice
// arrives says nothing about who did what or was online. It tells:
// - the questions that reached their person this morning (a kid's go to the kid's parents);
// - the celebrations a week away, to their people; and "Remind me": a celebration of someone `days` away, to whoever
//   asked;
// - a draw whose reveal date has come, to its people and its host;
// - gifts that reached their person (the day after the celebration, as their thank-yous show them), to that person
//   and, for a kid, the kid's parents.
// Each notice is made once (notices/notices.ts noticeId), so running it again, or after a restart, adds nothing. A
// batch missed (the server was off at 08:00) runs at the next start the same day; the questions and thank-yous of the
// last week are caught up too, the reminders only on their day.
import { and, eq, gte, lte } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { addDays, atHour, daysBetween, nextDate, today } from '../celebrations/dates';
import { allCelebrations, peopleByCelebration } from '../celebrations/celebrations';
import { revealed } from '../gifts/gifts';
import { household, managesKid, type Person } from '../household/people';
import { answersFor, BATCH_HOUR } from '../questions/questions';
import { latestDraws, isRevealed, participantsOf } from '../draws/draws';
import { KEEP_DAYS, pruneNotices, tell } from '../notices/notices';

/** A celebration's own people are reminded this many days before it. */
export const REMIND_DAYS = 7;
/** How far back a missed batch catches up questions, reveals and thank-yous. */
const CATCH_UP_DAYS = 7;

export const JOB = 'morning';

/** Whether today's batch is due at `now` and has not run. */
export function due(db: Db, cfg: Pick<Config, 'timezone'>, now: Date): boolean {
  const day = today(cfg.timezone, now);
  if (now < atHour(day, BATCH_HOUR, cfg.timezone)) return false;
  return !db.select().from(t.jobRun).where(and(eq(t.jobRun.name, JOB), eq(t.jobRun.day, day))).get();
}

/** The instant of the next batch after `now`. */
export function nextRun(cfg: Pick<Config, 'timezone'>, now: Date): Date {
  const day = today(cfg.timezone, now);
  const at = atHour(day, BATCH_HOUR, cfg.timezone);
  return now < at ? at : atHour(addDays(day, 1), BATCH_HOUR, cfg.timezone);
}

/** Runs the batch for `now` (from 08:00 on). Returns who was told something new, for the push queue. */
export function morning(db: Db, cfg: Pick<Config, 'timezone'>, now: Date): string[] {
  const day = today(cfg.timezone, now);
  if (now < atHour(day, BATCH_HOUR, cfg.timezone)) return [];
  const told = new Set<string>();
  const add = (ps: string[]) => { for (const p of ps) told.add(p); };
  const since = addDays(day, -CATCH_UP_DAYS);
  const people = household(db);
  const byId = new Map(people.map((p) => [p.id, p]));
  /** A person, or for a kid the kid's parents (the admins when none is set), as questions and thank-yous go. */
  const answerers = (p: Person) => people.filter((m) => answersFor(db, m, p)).map((m) => m.id);

  db.transaction(() => {
    // Questions that reached their person (at 08:00 the day after they were asked), still open.
    const qs = db.select().from(t.question).where(and(eq(t.question.state, 'open'), lte(t.question.deliverAt, now.toISOString()),
      gte(t.question.deliverAt, atHour(since, BATCH_HOUR, cfg.timezone).toISOString()))).all();
    for (const q of qs) {
      const p = byId.get(q.personId);
      if (p) add(tell(db, answerers(p), 'question', q.id, today(cfg.timezone, new Date(q.deliverAt))));
    }

    // Celebrations coming: their people a week before; "Remind me" whoever asked, the days they chose.
    const celebrations = allCelebrations(db);
    const cPeople = peopleByCelebration(db);
    const reminders = db.select().from(t.reminder).all();
    for (const c of celebrations) {
      const next = nextDate(c.date, c.recurrence, day);
      const days = daysBetween(day, next);
      const its = (cPeople.get(c.id) ?? []).filter((id) => byId.has(id));
      if (days === REMIND_DAYS) add(tell(db, its, 'remind', c.id, next));
      for (const r of reminders) {
        if (r.days === days && its.includes(r.aboutId) && byId.has(r.personId)) add(tell(db, [r.personId], 'remind', c.id, next, { aboutId: r.aboutId }));
      }
    }

    // A draw's reveal date: its people and its host, once its pairs show.
    const draws = latestDraws(db);
    for (const c of celebrations) {
      const d = draws.get(c.id);
      if (!d || !d.drawnAt || !d.revealOn || d.revealOn > day || d.revealOn < since || !isRevealed(c, d, day)) continue;
      const ps = participantsOf(db, [d.id]).filter((p) => p.kind === 'person' && p.personId).map((p) => p.personId!);
      add(tell(db, [...ps, ...(c.hostId ? [c.hostId] : [])].filter((id) => byId.has(id)), 'reveal', c.id, d.revealOn));
    }

    // Gifts that reached their person: the person (and a kid's parents) can say thank you. One notice a celebration.
    for (const o of revealed(db, day).over) {
      if (o.on > day || o.on < since) continue;
      const p = byId.get(o.personId);
      if (!p) continue;
      const to = p.role === 'kid' ? [p.id, ...people.filter((m) => managesKid(db, m, p)).map((m) => m.id)] : [p.id];
      add(tell(db, to, 'say_thanks', o.celebrationId ?? 'any', o.on));
    }

    pruneNotices(db, addDays(day, -KEEP_DAYS));
    db.insert(t.jobRun).values({ name: JOB, day, at: now.toISOString() }).onConflictDoNothing().run();
  });
  return [...told];
}

/** Runs the batch at every 08:00 (and now, if today's is due). Returns a stop function. */
export function scheduleMorning(db: Db, cfg: Pick<Config, 'timezone'>, run: (now: Date) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const now = new Date();
    if (due(db, cfg, now)) run(now);
    // At most a day ahead (timers cap at 24.8 days anyway), and a minute late rather than early.
    const wait = Math.min(Math.max(nextRun(cfg, now).getTime() - Date.now(), 0) + 1000, 86_400_000);
    timer = setTimeout(arm, wait);
    timer.unref();
  };
  arm();
  return () => { stopped = true; clearTimeout(timer); };
}
