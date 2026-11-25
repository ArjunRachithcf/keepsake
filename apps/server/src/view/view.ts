// The one view layer (ADR 0003). Every answer about the household is built here, for one viewer: routes never
// serialize database rows themselves. What the viewer may not see is removed first (`visible`), and only then are
// lists filtered by celebration, sorted or counted, so neither a filter, the order nor a count gives anything away.
// M2 adds claims and group gifts here, cut for the person a wish is for before the same steps.
//
// The viewer is always the request's (data.view(r)); each helper takes ids and builds its own answer, so no route can
// hand in a row, a ready object or somebody else to view as. The seam (src/seam.ts) then checks that the bytes sent are
// exactly an answer built here, and test/architecture.test.ts keeps routes away from the database.
import type * as api from '@keepsake/contracts';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialDescriptorJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { passkeysOf } from '../auth/passkeys';
import { canChange, allCelebrations, mustGetCelebration, peopleByCelebration, type Celebration } from '../celebrations/celebrations';
import { daysBetween, nextDate, today } from '../celebrations/dates';
import { currency, hasPasskey, household, keeps, managersOf, mustGetPerson, type Person } from '../household/people';
import { getProfile, type ProfileRow } from '../household/profile';
import { allWaiting, canApprove, canEdit, canSee, seeWish, wishesAddedBy, wishesOf, type Wish } from '../wishes/wishes';

/** Each answer with the request it was built for (the seam lets it out on that request only). */
const VIEWED = new WeakMap<object, object>();
declare const VIEWED_BRAND: unique symbol;
/** An answer the view layer built (the router takes only these; the seam checks the bytes as well). */
export type Viewed<T extends object = object> = T & { readonly [VIEWED_BRAND]: true };
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
/**
 * Marks an answer as built by the view layer for one request (only this module can) and freezes it: nothing can be
 * added after, and no other request can send it (a cached answer built for someone else is refused).
 */
function mark<T extends object>(owner: object, body: T): Viewed<T> {
  VIEWED.set(deepFreeze(body), owner);
  return body as Viewed<T>;
}
const marker = (owner: object) => <T extends object>(body: T): Viewed<T> => mark(owner, body);
/** Whether an answer came from the view layer (the seam asks before serializing it; src/seam.ts). */
export const isViewed = (payload: unknown): boolean => typeof payload === 'object' && payload !== null && VIEWED.has(payload);
/** The request an answer was built for, if the view layer built it. */
export const builtFor = (payload: unknown): object | undefined => (typeof payload === 'object' && payload !== null ? VIEWED.get(payload) : undefined);

/** `for`: a celebration's list (its wishes and the any-time ones), the any-time wishes only, or everything. */
export type ListFor = { celebration: string } | 'any' | null;

const json = <T>(s: string): T => JSON.parse(s) as T;
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('view: not a string');
  return v;
};
const opt = <T>(v: T | undefined, f: (x: T) => unknown) => (v === undefined ? undefined : f(v));
const strings = (v: readonly unknown[] | undefined) => opt(v, (l) => l.map(str));
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const descriptor = (d: PublicKeyCredentialDescriptorJSON) => defined({ id: str(d.id), type: str(d.type), transports: strings(d.transports) });

/**
 * WebAuthn's registration options, copied field by field into the shape the browser needs: whatever else the object
 * carried stays behind.
 */
function creationOptions(o: PublicKeyCredentialCreationOptionsJSON): Record<string, unknown> {
  return defined({
    rp: defined({ name: str(o.rp.name), id: opt(o.rp.id, str) }),
    user: { id: str(o.user.id), name: str(o.user.name), displayName: str(o.user.displayName) },
    challenge: str(o.challenge),
    pubKeyCredParams: o.pubKeyCredParams.map((p) => ({ alg: Number(p.alg), type: str(p.type) })),
    timeout: opt(o.timeout, Number),
    excludeCredentials: opt(o.excludeCredentials, (l) => l.map(descriptor)),
    authenticatorSelection: opt(o.authenticatorSelection, (a) => defined({
      authenticatorAttachment: opt(a.authenticatorAttachment, str), residentKey: opt(a.residentKey, str),
      requireResidentKey: opt(a.requireResidentKey, Boolean), userVerification: opt(a.userVerification, str),
    })),
    hints: strings(o.hints),
    attestation: opt(o.attestation, str),
    extensions: opt(o.extensions?.credProps, (c) => ({ credProps: Boolean(c) })),
  });
}
/** The same for a sign-in's options. */
function requestOptions(o: PublicKeyCredentialRequestOptionsJSON): Record<string, unknown> {
  return defined({
    challenge: str(o.challenge),
    timeout: opt(o.timeout, Number),
    rpId: opt(o.rpId, str),
    allowCredentials: opt(o.allowCredentials, (l) => l.map(descriptor)),
    userVerification: opt(o.userVerification, str),
    hints: strings(o.hints),
  });
}

/** Answers that need no viewer: the server's health, the sign-in steps, and the person a passkey has just signed in. */
export function publicViewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone'>, owner: object) {
  const answer = marker(owner);
  return {
    health: (version: string): Viewed<api.Health> => answer({ ok: true, version, mode: cfg.mode }),
    signInStart: (challengeId: string, o: PublicKeyCredentialRequestOptionsJSON): Viewed<api.SignInStart> => answer({ challengeId, options: requestOptions(o) }),
    enrolStart: (challengeId: string, o: PublicKeyCredentialCreationOptionsJSON): Viewed<api.EnrolStart> =>
      answer({ challengeId, options: creationOptions(o), person: { name: str(o.user.name) } }),
    signedOut: (setupNeeded: boolean): Viewed<api.AuthSession> => answer({ mode: cfg.mode, signedIn: false, setupNeeded }),
    signedIn: (personId: string): Viewed<api.AuthSession> => viewFor(db, cfg, mustGetPerson(db, personId), owner).signedIn(),
  };
}

/** A one-time link, from what createInvite returned (data.ts hands it over; routes never get one to pass). */
export const linkAnswer = (owner: object, i: { url: string; expiresAt: Date }): Viewed<api.OneTimeLink> => mark(owner, { url: str(i.url), expiresAt: i.expiresAt.toISOString() });

export function viewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone'>, viewer: Person, owner: object) {
  const answer = marker(owner);
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
    quantity: w.quantity, note: w.note, mostWanted: w.mostWanted === 1, state: w.state,
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

  // Every helper builds its own answer from ids, for this viewer: none takes a person, a row or a ready object.
  return {
    signedIn: (): Viewed<api.AuthSession> => answer({ mode: cfg.mode, signedIn: true, setupNeeded: false, person: person(viewer) }),
    household: (): Viewed<api.Household> => answer({ mode: cfg.mode, me: person(viewer), people: [...people().values()].map(person), currency: currency(db) }),
    person: (id: string): Viewed<api.Person> => answer(person(mustGetPerson(db, id))),
    profile: (personId: string): Viewed<api.Profile> => answer(profile(getProfile(db, mustGetPerson(db, personId).id))),
    /** The viewer's own passkeys: nobody lists someone else's. */
    passkeys: (): Viewed<api.Passkeys> => answer({ passkeys: passkeysOf(db, viewer.id).map((k) => ({ ...k })) }),
    /** One wish the viewer may see (404 otherwise, the same answer whether it exists or is hidden). */
    wish: (id: string): Viewed<api.Wish> => answer(wish(seeWish(db, viewer, id))),
    home: (f: ListFor): Viewed<api.Home> => {
      const mine = upcoming(celebrationsOf(viewer.id));
      const approvals = waiting();
      return answer({
        next: mine[0] ?? null,
        celebrations: mine,
        wishes: listOf(viewer.id, f),
        suggestions: approvals.filter((w) => w.personId === viewer.id).sort(byPosition).map(wish),
        toApprove: approvals.filter((w) => w.personId !== viewer.id).sort(byPosition).map(wish),
        suggested: wishes(wishesAddedBy(db, viewer.id, 'suggested')).filter((w) => w.personId !== viewer.id),
      });
    },
    personPage: (id: string, f: ListFor): Viewed<api.PersonPage> => {
      const p = mustGetPerson(db, id);
      return answer({
        person: person(p),
        profile: profile(getProfile(db, p.id)),
        celebrations: upcoming(celebrationsOf(p.id)),
        wishes: listOf(p.id, f),
        keeps: keeps(db, viewer, p),
      });
    },
    celebrations: (): Viewed<api.Celebrations> => {
      const all = celebrationsOf(null);
      return answer({
        upcoming: upcoming(all),
        past: all.filter((c) => !c.upcoming).sort((a, b) => b.nextDate.localeCompare(a.nextDate)),
      });
    },
    celebration: (id: string): Viewed<api.Celebration> => answer(celebration(mustGetCelebration(db, id))),
    celebrationPage: (id: string): Viewed<api.CelebrationPage> => {
      const view = celebration(mustGetCelebration(db, id));
      return answer({
        celebration: view,
        lists: view.people.map((pid) => people().get(pid)).filter((p): p is Person => Boolean(p))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ person: person(p), wishes: listOf(p.id, { celebration: id }) })),
      });
    },
  };
}

export type View = ReturnType<typeof viewFor>;
