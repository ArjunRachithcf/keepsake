// The one view layer (ADR 0003). Every answer about the household is built here, for one viewer: routes never
// serialize database rows themselves. What the viewer may not see is removed first (`visible`), and only then are
// lists filtered by celebration, sorted or counted, so neither a filter, the order nor a count gives anything away.
//
// Gifts (M2): the first step of every list (`seen`) gives each wish its gifts only for a viewer who `seesGifts` (not
// its person, not a kid); for anyone else no gift is read at all. Every step after it (gone, the `for` filter, the
// order, counts) works on what `seen` made, so for the person a list cannot depend on its gifts. The one exception is
// by design and after the fact: a wish whose gifts were all given and whose celebration is over is gone for its person
// too (`receivedIds`), and the thank-yous name only the givers who chose it.
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
import { NO_GIFTS, calendarOf, fullyGiven, gaveBy, giftsOf, isOver, managesGroup, occasionOf, revealed, seesGifts, thanksFor, type Gifts } from '../gifts/gifts';
import { allWaiting, canApprove, canEdit, canSee, getWish, seeWish, wishesAddedBy, wishesOf, type Wish } from '../wishes/wishes';

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

  /** What the viewer may see of a wish's gifts: everything for a giver (others' shares as names only), else nothing. */
  const gift = (w: Wish, g: Gifts): api.Gift => {
    const byTime = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const claimed = g.claims.reduce((n, c) => n + c.quantity, 0);
    const myClaim = g.claims.find((c) => c.giverId === viewer.id);
    const myShare = g.shares.find((x) => x.giverId === viewer.id);
    const mine = g.group ? (myShare ? { state: g.group.state, named: myShare.named === 1, dated: g.group } : null)
      : myClaim ? { state: myClaim.state, named: myClaim.named === 1, dated: myClaim } : null;
    return {
      claimed,
      left: g.group ? 0 : Math.max(0, w.quantity - claimed),
      given: fullyGiven(w, g),
      claims: byTime(g.claims).map((c) => ({ giver: ref(c.giverId), quantity: c.quantity, state: c.state, mine: c.giverId === viewer.id })),
      group: g.group ? {
        organizer: ref(g.group.organizerId), targetMinor: g.group.targetMinor, state: g.group.state,
        totalMinor: g.shares.reduce((n, x) => n + x.amountMinor, 0),
        givers: byTime(g.shares).map((x) => ({ giver: ref(x.giverId), mine: x.giverId === viewer.id })),
        myShareMinor: myShare?.amountMinor ?? null,
        canManage: managesGroup(db, viewer, g.group),
      } : null,
      mine: mine ? (() => {
        const occ = occasionOf(w, mine.dated.givenOn ?? now, calendar());
        return { state: mine.state, named: mine.named, over: isOver(w, mine.dated, calendar(), now), celebrationId: occ.celebrationId, forDate: occ.date };
      })() : null,
    };
  };
  type Seen = { w: Wish; gift?: api.Gift };
  const calendar = lazy(() => calendarOf(db));
  // What the household has received: the same work whatever is hidden from this viewer (gifts/gifts.ts `revealed`).
  const received = lazy(() => revealed(db, now).received);
  /** The first step of every list: only what the viewer may see, and gifts read only for the wishes of a giver's. */
  const seen = (rows: Wish[]): Seen[] => {
    const shown = rows.filter((w) => canSee(db, viewer, w));
    const gifts = giftsOf(db, shown.filter((w) => seesGifts(viewer, w)).map((w) => w.id));
    return shown.map((w) => (seesGifts(viewer, w) ? { w, gift: gift(w, gifts.get(w.id) ?? NO_GIFTS) } : { w }));
  };
  /** "Given once, gone everywhere": for a giver once it is all given; for its person and kids once received. */
  const present = (xs: Seen[]) => xs.filter((x) => (x.gift ? !x.gift.given : !received().has(x.w.id)));
  const byPosition = (a: Seen, b: Seen) => a.w.position - b.w.position || a.w.createdAt.localeCompare(b.w.createdAt);
  const onList = (xs: Seen[], f: ListFor) => xs.filter(({ w }) => w.state !== 'suggested'
    && (f === null || (f === 'any' ? w.celebrationId === null : w.celebrationId === null || w.celebrationId === f.celebration)));

  const wishOf = (w: Wish): api.Wish => ({
    id: w.id, personId: w.personId, celebrationId: w.celebrationId, name: w.name, link: w.link, priceMinor: w.priceMinor,
    quantity: w.quantity, note: w.note, mostWanted: w.mostWanted === 1, state: w.state,
    addedBy: w.addedBy && w.addedBy !== w.personId ? ref(w.addedBy) : null,
    createdAt: w.createdAt, updatedAt: w.updatedAt,
    canEdit: canEdit(db, viewer, w), canApprove: canApprove(db, viewer, w),
  });
  const wish = ({ w, gift: g }: Seen): api.Wish => (g ? { ...wishOf(w), gift: g } : wishOf(w));
  const wishes = (rows: Wish[]) => seen(rows).sort(byPosition).map(wish);
  const listOf = (personId: string, f: ListFor) => onList(present(seen(wishesOf(db, [personId]))), f).sort(byPosition).map(wish);

  const celebrationPeople = lazy(() => peopleByCelebration(db));
  const waiting = () => seen(allWaiting(db)).filter(({ w }) => canApprove(db, viewer, w));
  const celebration = (c: Celebration, approvals = waiting()): api.Celebration => {
    const next = nextDate(c.date, c.recurrence, now);
    const days = daysBetween(now, next);
    return {
      id: c.id, name: c.name, date: c.date, nextDate: next, daysUntil: days, upcoming: days >= 0, place: c.place,
      poster: c.poster, recurrence: c.recurrence, host: ref(c.hostId), people: celebrationPeople().get(c.id) ?? [],
      toApprove: approvals.filter(({ w }) => w.celebrationId === c.id).length,
      canEdit: canChange(viewer, c),
    };
  };
  const celebrationNames = lazy(() => new Map(allCelebrations(db).map((c) => [c.id, c.name])));
  const celebrationRef = (id: string | null): api.CelebrationRef | null => {
    const name = id ? celebrationNames().get(id) : undefined;
    return id && name ? { id, name } : null;
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
    wish: (id: string): Viewed<api.Wish> => answer(wish(seen([seeWish(db, viewer, id)])[0]!)),
    home: (f: ListFor): Viewed<api.Home> => {
      const mine = upcoming(celebrationsOf(viewer.id));
      const approvals = waiting();
      return answer({
        next: mine[0] ?? null,
        celebrations: mine,
        wishes: listOf(viewer.id, f),
        suggestions: approvals.filter(({ w }) => w.personId === viewer.id).sort(byPosition).map(wish),
        toApprove: approvals.filter(({ w }) => w.personId !== viewer.id).sort(byPosition).map(wish),
        suggested: wishes(wishesAddedBy(db, viewer.id, 'suggested')).filter((w) => w.personId !== viewer.id),
        // After the celebration: thank-yous (named givers only) for the viewer's gifts and, for a kid's parent, the
        // kid's; and the gifts the viewer gave, to put their name on.
        thanks: thanksFor(db, viewer, now).flatMap((x) => {
          const row = getWish(db, x.wishId);
          const [s] = row ? seen([row]) : [];
          if (!s) return [];
          // A kid's parent sees the kid's wish with its gifts; a thank-you carries the wish as its person sees it.
          return [{ wish: wishOf(s.w), celebration: celebrationRef(x.celebrationId), on: x.on, from: x.from.map(ref).filter((r): r is api.PersonRef => r !== null) }];
        }),
        gave: viewer.role === 'kid' ? [] : gaveBy(db, viewer.id, now).flatMap((x) => {
          const row = getWish(db, x.wishId);
          return (row ? seen([row]) : []).filter((s) => s.gift)
            .map((s) => ({ wish: wish(s), celebration: celebrationRef(x.celebrationId), on: x.on, named: x.named }));
        }),
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
