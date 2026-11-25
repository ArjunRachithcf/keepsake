// The one view layer (ADR 0003). Every answer about the household is built here, for one viewer: routes never
// serialize database rows themselves. What the viewer may not see is removed first (`visible`), and only then are
// lists filtered by celebration, sorted or counted, so neither a filter, the order nor a count gives anything away.
// M2 adds claims and group gifts here, cut for the person a wish is for before the same steps.
//
// The seam is enforced twice: a route answer that did not come from here is refused with a 500 by the API's
// preSerialization hook (`isViewed`), and test/architecture.test.ts keeps routes away from the database rows.
import type * as api from '@keepsake/contracts';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { canChange, allCelebrations, peopleByCelebration, type Celebration } from '../celebrations/celebrations';
import { daysBetween, nextDate, today } from '../celebrations/dates';
import { currency, hasPasskey, household, keeps, managersOf, type Person } from '../household/people';
import { getProfile, type ProfileRow } from '../household/profile';
import { allWaiting, canApprove, canEdit, canSee, wishesAddedBy, wishesOf, type Wish } from '../wishes/wishes';

const VIEWED = new WeakSet<object>();
/** Marks an answer as built by the view layer; only this module can. */
function answer<T extends object>(body: T): T {
  VIEWED.add(body);
  return body;
}
/** Whether a route's answer came from the view layer (checked for every /api answer below 400). */
export const isViewed = (payload: unknown): boolean => typeof payload === 'object' && payload !== null && VIEWED.has(payload);

/** `for`: a celebration's list (its wishes and the any-time ones), the any-time wishes only, or everything. */
export type ListFor = { celebration: string } | 'any' | null;

const json = <T>(s: string): T => JSON.parse(s) as T;

/** Answers that need no viewer: the server's health and the sign-in steps. */
export const publicView = {
  health: (cfg: Pick<Config, 'mode'>, version: string): api.Health => answer({ ok: true, version, mode: cfg.mode }),
  signInStart: (challengeId: string, options: object): api.SignInStart => answer({ challengeId, options: options as Record<string, unknown> }),
  enrolStart: (challengeId: string, options: object, name: string): api.EnrolStart => answer({ challengeId, options: options as Record<string, unknown>, person: { name } }),
  signedOut: (cfg: Pick<Config, 'mode'>, setupNeeded: boolean): api.AuthSession => answer({ mode: cfg.mode, signedIn: false, setupNeeded }),
};

export function viewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone'>, viewer: Person) {
  const now = today(cfg.timezone);
  // Read when the first answer is built, not when the view is made: a route may change things in between
  // (`view(req).wish(editWish(...))` makes the view first).
  const lazy = <T>(f: () => T) => { let v: T | undefined; return () => (v ??= f()); };
  const people = lazy(() => new Map(household(db).map((p) => [p.id, p])));
  const ref = (id: string | null): api.PersonRef | null => {
    const p = id ? people().get(id) : undefined;
    return p ? { id: p.id, name: p.name } : null;
  };

  const person = (p: Person): api.Person => ({
    id: p.id, name: p.name, role: p.role,
    managers: p.role === 'kid' ? managersOf(db, p.id) : [],
    signsIn: cfg.mode === 'standalone' ? hasPasskey(db, p.id) : null,
  });

  /** The first step of every list: only what the viewer may see. */
  const visible = (rows: Wish[]) => rows.filter((w) => canSee(db, viewer, w));
  const byPosition = (a: Wish, b: Wish) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
  const onList = (rows: Wish[], f: ListFor) => rows.filter((w) => w.state !== 'suggested'
    && (f === null || (f === 'any' ? w.celebrationId === null : w.celebrationId === null || w.celebrationId === f.celebration)));

  const wish = (w: Wish): api.Wish => ({
    id: w.id, personId: w.personId, celebrationId: w.celebrationId, name: w.name, link: w.link, priceMinor: w.priceMinor,
    quantity: w.quantity, note: w.note, mostWanted: w.mostWanted === 1, position: w.position, state: w.state,
    addedBy: w.addedBy && w.addedBy !== w.personId ? ref(w.addedBy) : null,
    createdAt: w.createdAt, updatedAt: w.updatedAt,
    canEdit: canEdit(db, viewer, w), canApprove: canApprove(db, viewer, w),
  });
  const wishes = (rows: Wish[]) => visible(rows).sort(byPosition).map(wish);
  const listOf = (personId: string, f: ListFor) => onList(visible(wishesOf(db, [personId])), f).sort(byPosition).map(wish);

  const celebrationPeople = lazy(() => peopleByCelebration(db));
  const waiting = () => visible(allWaiting(db)).filter((w) => canApprove(db, viewer, w));
  const celebration = (c: Celebration, approvals = waiting()): api.Celebration => {
    const next = nextDate(c.date, c.recurrence, now);
    const days = daysBetween(now, next);
    return {
      id: c.id, name: c.name, date: c.date, nextDate: next, daysUntil: days, upcoming: days >= 0, place: c.place,
      poster: c.poster, recurrence: c.recurrence, host: ref(c.hostId), people: celebrationPeople().get(c.id) ?? [],
      toApprove: approvals.filter((w) => w.celebrationId === c.id).length,
      canEdit: canChange(viewer, c),
    };
  };
  const celebrationsOf = (personId: string | null) => {
    const approvals = waiting();
    return allCelebrations(db).map((c) => celebration(c, approvals))
      .filter((c) => personId === null || c.people.includes(personId));
  };
  const upcoming = (cs: api.Celebration[]) => cs.filter((c) => c.upcoming).sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name));

  const profile = (r: ProfileRow): api.Profile => ({
    sizes: json(r.sizesJson), sizesUpdatedAt: r.sizesUpdatedAt,
    likes: json(r.likesJson), likesUpdatedAt: r.likesUpdatedAt,
    pleaseNo: json(r.pleaseNoJson), pleaseNoUpdatedAt: r.pleaseNoUpdatedAt,
  });

  return {
    signedIn: (): api.AuthSession => answer({ mode: cfg.mode, signedIn: true, setupNeeded: false, person: person(viewer) }),
    household: (): api.Household => answer({ mode: cfg.mode, me: person(viewer), people: [...people().values()].map(person), currency: currency(db) }),
    person: (p: Person): api.Person => answer(person(p)),
    profile: (r: ProfileRow): api.Profile => answer(profile(r)),
    link: (url: string, expiresAt: Date): api.OneTimeLink => answer({ url, expiresAt: expiresAt.toISOString() }),
    /** One wish the viewer may see (the domain modules have checked; checked again here). */
    wish: (w: Wish): api.Wish => {
      if (!canSee(db, viewer, w)) throw new Error('view: a wish the viewer may not see');
      return answer(wish(w));
    },
    home: (f: ListFor): api.Home => {
      const mine = upcoming(celebrationsOf(viewer.id));
      const approvals = waiting();
      return answer({
        next: mine[0] ?? null,
        celebrations: mine,
        wishes: listOf(viewer.id, f),
        suggestions: approvals.filter((w) => w.personId === viewer.id).sort(byPosition).map(wish),
        toApprove: approvals.filter((w) => w.personId !== viewer.id).sort(byPosition).map(wish),
        suggested: wishes(wishesAddedBy(db, viewer.id, 'suggested').filter((w) => w.personId !== viewer.id)),
      });
    },
    personPage: (p: Person, f: ListFor): api.PersonPage => answer({
      person: person(p),
      profile: profile(getProfile(db, p.id)),
      celebrations: upcoming(celebrationsOf(p.id)),
      wishes: listOf(p.id, f),
      keeps: keeps(db, viewer, p),
    }),
    celebrations: (): api.Celebrations => {
      const all = celebrationsOf(null);
      return answer({
        upcoming: upcoming(all),
        past: all.filter((c) => !c.upcoming).sort((a, b) => b.nextDate.localeCompare(a.nextDate)),
      });
    },
    celebration: (c: Celebration): api.Celebration => answer(celebration(c)),
    celebrationPage: (c: Celebration): api.CelebrationPage => {
      const view = celebration(c);
      return answer({
        celebration: view,
        lists: view.people.map((id) => people().get(id)).filter((p): p is Person => Boolean(p))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ person: person(p), wishes: listOf(p.id, { celebration: c.id }) })),
      });
    },
  };
}

export type View = ReturnType<typeof viewFor>;
