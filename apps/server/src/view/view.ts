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
import {
  canRedraw, dayHasCome, dayOfInstant, exclusionsOf, hostRoleOf, latestDraw, latestDraws, managesDraw, occasionOf as drawDay, openAll, openOwn, opensNow, participantsOf,
  revealedNow, unrevealedDraws, type Participant,
} from '../draws/draws';
import { keyring } from '../draws/sealed';
import { Refused } from '../errors';
import * as t from '../db/schema';
import { answersFor, getQuestion, givesTo, isAsker, isDelivered, questionsFor, seesQuestion, type Question } from '../questions/questions';
import { getIdea, ideasFor, seesIdeas } from '../ideas/ideas';
import { getLink, lastDayOf, linksFor, managesLink, reachOf, reaches, type GuestLink } from '../guests/guests';
import { guestPlace } from '../draws/draws';
import type { Plan } from '../import/import';
import { and, eq } from 'drizzle-orm';
import { noticesOf, type Notice } from '../notices/notices';
import { usableVapid } from '../push/keys';
import { getThankYou, thankedBy, thankYouFor } from '../thanks/thanks';
import type { Preview } from '../wishes/preview';

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
const profile = (r: ProfileRow): api.Profile => ({
  sizes: json(r.sizesJson), sizesUpdatedAt: r.sizesUpdatedAt,
  likes: json(r.likesJson), likesUpdatedAt: r.likesUpdatedAt,
  pleaseNo: json(r.pleaseNoJson), pleaseNoUpdatedAt: r.pleaseNoUpdatedAt,
});
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
export function publicViewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone' | 'sealingKey' | 'sealingKeyPrevious'>, owner: object) {
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

/** The names guests gave (or their link's label), by link id. */
function guestNamesOf(db: Db): Map<string, string> {
  return new Map(guestRefsOf(db).map((g) => [g.id, g.name]));
}
/** A guest as the household sees them on a claim: marked a guest, with their name and their link's label (review M2). */
function guestRefsOf(db: Db): (api.GuestRef & { id: string })[] {
  return db.select({ id: t.guestLink.id, label: t.guestLink.label, name: t.guestLink.guestName }).from(t.guestLink).all()
    .map((g) => ({ id: g.id, name: g.name ?? g.label, label: g.label }));
}
/** A question as a giver sees it (ADR 0008): never who asked; `mine` says only whether the viewer did. */
function askedOf(q: Question, mine: boolean, now: Date, tz: string, wishName: (id: string) => string | null): api.AskedQuestion {
  const delivered = isDelivered(q, now);
  const name = q.answerWishId ? wishName(q.answerWishId) : null;
  return {
    id: q.id, text: q.text, on: today(tz, new Date(q.deliverAt)),
    state: delivered ? q.state : 'waiting',
    answer: q.state === 'answered' ? q.answer : null,
    wish: q.answerWishId && name ? { id: q.answerWishId, name } : null,
    mine, arrivesAt: mine && !delivered ? q.deliverAt : null,
  };
}
/** Newest morning first; within a morning by id (random, so the order says nothing about who asked or when). */
const byMorning = (a: Question, b: Question) => b.deliverAt.localeCompare(a.deliverAt) || a.id.localeCompare(b.id);

/** A one-time link, from what createInvite returned (data.ts hands it over; routes never get one to pass). */
export const linkAnswer = (owner: object, i: { url: string; expiresAt: Date }): Viewed<api.OneTimeLink> => mark(owner, { url: str(i.url), expiresAt: i.expiresAt.toISOString() });

export function viewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone' | 'sealingKey' | 'sealingKeyPrevious'> & Partial<Pick<Config, 'vapidKey' | 'egress' | 'shopHosts'>>, viewer: Person, owner: object) {
  const answer = marker(owner);
  const instant = new Date();
  const now = today(cfg.timezone, instant);
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

  /**
   * Review H1: while a draw is drawn and not revealed, a gift by one of its people to another (made up to its day, on
   * any of their wishes) names no giver to anyone but the giver: "Sam claimed Robin's wish" would say "Sam drew Robin".
   * The counts stay, so nobody buys twice. This depends on who is in which draw, never on who drew whom.
   */
  const live = lazy(() => unrevealedDraws(db, now));
  /** `key`: a person's id, or `g:<link id>` for a guest (gifts/gifts.ts giverKey). The same rule holds for ideas. */
  const unnamed = (personId: string, key: string | null, at: string) => key !== null && key !== viewer.id
    && live().some((d) => d.people.has(key) && d.people.has(personId) && dayOfInstant(cfg.timezone, at) <= d.on);
  const giverRef = (w: Wish, giverId: string | null, at: string) => (unnamed(w.personId, giverId, at) ? null : ref(giverId));
  const guestNames = lazy(() => guestNamesOf(db));
  const guestRefs = lazy(() => new Map(guestRefsOf(db).map((g) => [g.id, { name: g.name, label: g.label }])));
  const guestRef = (w: Wish, guestId: string | null, at: string): api.GuestRef | null =>
    (!guestId || unnamed(w.personId, `g:${guestId}`, at) ? null : guestRefs().get(guestId) ?? null);
  /** What the viewer may see of a wish's gifts: everything for a giver (others' shares as names only), else nothing. */
  const gift = (w: Wish, g: Gifts): api.Gift => {
    const byTime = <T extends { createdAt: string; id: string }>(xs: T[]) => [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const claimed = g.claims.reduce((n, c) => n + c.quantity, 0);
    const myClaim = g.claims.find((c) => c.giverId === viewer.id);
    const myShare = g.shares.find((x) => x.giverId === viewer.id);
    const mine = g.group ? (myShare ? { state: g.group.state, named: myShare.named === 1, dated: g.group } : null)
      : myClaim ? { state: myClaim.state, named: myClaim.named === 1, dated: myClaim } : null;
    return {
      claimed,
      left: g.group ? 0 : Math.max(0, w.quantity - claimed),
      given: fullyGiven(w, g),
      claims: byTime(g.claims).map((c) => ({
        giver: giverRef(w, c.giverId, c.createdAt), guest: guestRef(w, c.guestId, c.createdAt), imported: c.imported === 1, quantity: c.quantity, state: c.state, mine: c.giverId === viewer.id,
      })),
      group: g.group ? {
        organizer: giverRef(w, g.group.organizerId, g.group.createdAt), targetMinor: g.group.targetMinor, state: g.group.state,
        totalMinor: g.shares.reduce((n, x) => n + x.amountMinor, 0),
        givers: byTime(g.shares).map((x) => ({ giver: giverRef(w, x.giverId, x.createdAt), mine: x.giverId === viewer.id })),
        myShareMinor: myShare?.amountMinor ?? null,
        canManage: managesGroup(db, viewer, g.group),
      } : null,
      mine: mine ? (() => {
        const occ = occasionOf(w, mine.dated.givenOn ?? now, calendar());
        // Given: the reveal never moves earlier than the occasion kept when it was given.
        if (mine.dated.occasionOn && (!occ.date || mine.dated.occasionOn > occ.date)) occ.date = mine.dated.occasionOn;
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

  // Draws (ADR 0004): what anyone may know of a draw is who is in it, its settings, and how many have opened theirs.
  // Only `draw()` opens a sealed row: the viewer's own, once they opened it; every row only after the reveal.
  const draws = lazy(() => latestDraws(db));
  const drawPeople = lazy(() => {
    const m = new Map<string, Participant[]>();
    for (const p of participantsOf(db, [...draws().values()].map((d) => d.id))) m.set(p.drawId, [...(m.get(p.drawId) ?? []), p]);
    return m;
  });
  const isMine = (p: Participant) => p.kind === 'person' && p.personId === viewer.id;
  const drawSummary = (c: Celebration): api.DrawSummary | null => {
    const d = draws().get(c.id);
    if (!d) return null;
    const ps = drawPeople().get(d.id) ?? [];
    const mine = ps.find(isMine);
    return {
      year: d.year, on: drawDay(c, d), drawn: d.drawnAt !== null, opened: ps.filter((p) => p.openedAt).length, total: ps.length,
      mine: !mine ? 'out' : mine.openedAt ? 'opened' : opensNow(d, instant) ? 'ready' : 'waiting',
    };
  };
  const byName = (a: api.PersonRef | null, b: api.PersonRef | null) => (a?.name ?? '').localeCompare(b?.name ?? '') || (a?.id ?? '').localeCompare(b?.id ?? '');
  const ring = lazy(() => keyring(cfg));
  const waiting = () => seen(allWaiting(db)).filter(({ w }) => canApprove(db, viewer, w));
  const celebration = (c: Celebration, approvals = waiting()): api.Celebration => {
    const next = nextDate(c.date, c.recurrence, now);
    const days = daysBetween(now, next);
    return {
      id: c.id, name: c.name, date: c.date, nextDate: next, daysUntil: days, upcoming: days >= 0, place: c.place,
      poster: c.poster, recurrence: c.recurrence, host: ref(c.hostId), people: celebrationPeople().get(c.id) ?? [],
      toApprove: approvals.filter(({ w }) => w.celebrationId === c.id).length,
      canEdit: canChange(viewer, c),
      draw: drawSummary(c),
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

  // Questions (ADR 0008): what the viewer may see, the asker never (only `mine`, about the viewer themselves).
  const wishName = (id: string) => { const w = getWish(db, id); return w && canSee(db, viewer, w) ? w.name : null; };
  const asked = (q: Question) => askedOf(q, isAsker(q, { personId: viewer.id }), instant, cfg.timezone, wishName);
  const questionsOf = (personId: string) => questionsFor(db, [personId]).filter((q) => seesQuestion(db, viewer, q, instant)).sort(byMorning).map(asked);
  // Ideas: only for a viewer who `seesIdeas`; for anyone else none is read. Named as gifts are (review H1).
  // Only the day, newest first, then by (random) id: no idea tells the moment it was written (review L4).
  const ideasOf = (personId: string): api.Idea[] => ideasFor(db, [personId])
    .map((i) => ({ i, on: dayOfInstant(cfg.timezone, i.createdAt) }))
    .sort((a, b) => b.on.localeCompare(a.on) || a.i.id.localeCompare(b.i.id))
    .map(({ i, on }) => ({ id: i.id, text: i.text, by: unnamed(personId, i.authorId, i.createdAt) ? null : ref(i.authorId), mine: i.authorId === viewer.id, on }));
  const link = (l: GuestLink): api.GuestLink => ({
    id: l.id, kind: l.kind, label: l.label, guestName: l.guestName,
    person: l.personId ? ref(l.personId) : null, celebration: celebrationRef(l.celebrationId),
    lastDay: lastDayOf(db, l), createdAt: l.createdAt, openedAt: l.openedAt, revokedAt: l.revokedAt,
    reissuedAt: l.reissuedAt, reissueCount: l.reissueCount,
  });
  const mustLink = (id: string) => {
    const l = getLink(db, id);
    if (!l || l.revokedAt || !managesLink(db, viewer, l)) throw new Refused(404, 'no such link');
    return l;
  };

  // Thank-yous (ADR 0010): the viewer's received gifts (and a kid's, for their parents), with the thank-you written for
  // each, if any; and the thank-yous for gifts the viewer gave. The writer never learns who the givers are.
  const thanksList = (): api.Thanks[] => {
    const xs = thanksFor(db, viewer, now);
    const sent = thankYouFor(db, xs.map((x) => x.wishId));
    return xs.flatMap((x) => {
      const row = getWish(db, x.wishId);
      const [s] = row ? seen([row]) : [];
      if (!s) return [];
      const ty = sent.get(x.wishId);
      // A kid's parent sees the kid's wish with its gifts; a thank-you carries the wish as its person sees it.
      return [{
        wish: wishOf(s.w), celebration: celebrationRef(x.celebrationId), on: x.on, from: x.from.map(ref).filter((r): r is api.PersonRef => r !== null),
        sent: ty ? { text: ty.text, on: ty.day, by: ref(ty.writtenBy) } : null,
      }];
    });
  };
  const thankedList = (): api.ThankedYou[] => (viewer.role === 'kid' ? [] : thankedBy(db, viewer.id, now).flatMap((x) => {
    const w = getWish(db, x.wishId);
    if (!w || !canSee(db, viewer, w)) return [];
    return [{ id: x.id, wish: { id: w.id, name: w.name }, from: ref(x.personId), by: x.writtenBy && x.writtenBy !== x.personId ? ref(x.writtenBy) : null, text: x.text, on: x.day }];
  }));
  /**
   * A notice as the viewer may see it now (ADR 0010), or nothing: a pointer to a celebration, a question or a
   * thank-you, checked again by the same rules as every other answer (a question they no longer answer, a celebration
   * gone, a thank-you for a gift no longer theirs: dropped).
   */
  const noticeOf = (n: Notice): api.Notice[] => {
    const base = { id: n.id, kind: n.kind, on: n.day, read: n.readAt !== null, celebration: null, person: null, question: null };
    switch (n.kind) {
      case 'question': {
        const q = getQuestion(db, n.subjectId);
        const p = q ? people().get(q.personId) : undefined;
        if (!q || !p || !answersFor(db, viewer, p) || !isDelivered(q, instant)) return [];
        return [{ ...base, person: ref(p.id), question: q.id }];
      }
      case 'answered': {
        const q = getQuestion(db, n.subjectId);
        if (!q || !isAsker(q, { personId: viewer.id }) || q.state === 'open') return [];
        return [{ ...base, person: ref(q.personId), question: q.id }];
      }
      case 'draw': case 'reveal': {
        const c = celebrationRef(n.subjectId);
        return c ? [{ ...base, celebration: c }] : [];
      }
      case 'remind': {
        const c = celebrationRef(n.subjectId);
        return c ? [{ ...base, celebration: c, person: n.aboutId ? ref(n.aboutId) : null }] : [];
      }
      case 'say_thanks': return [{ ...base, celebration: n.subjectId === 'any' ? null : celebrationRef(n.subjectId) }];
      case 'thanked': {
        const ty = getThankYou(db, n.subjectId);
        const mine = ty ? thankedList().find((x) => x.id === ty.id) : undefined;
        return mine ? [{ ...base, person: mine.from }] : [];
      }
    }
  };
  const reminderFor = (personId: string): number | null => (personId === viewer.id ? null
    : db.select({ days: t.reminder.days }).from(t.reminder).where(and(eq(t.reminder.personId, viewer.id), eq(t.reminder.aboutId, personId))).get()?.days ?? null);

  // Every helper builds its own answer from ids, for this viewer: none takes a person, a row or a ready object.
  return {
    signedIn: (): Viewed<api.AuthSession> => answer({ mode: cfg.mode, signedIn: true, setupNeeded: false, person: person(viewer) }),
    household: (): Viewed<api.Household> => answer({
      mode: cfg.mode, me: person(viewer), people: [...people().values()].map(person), currency: currency(db),
      addFromLink: cfg.egress !== false && (cfg.shopHosts?.length ?? 0) > 0,
    }),
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
        thanks: thanksList(),
        thanked: thankedList(),
        gave: viewer.role === 'kid' ? [] : gaveBy(db, viewer.id, now).flatMap((x) => {
          const row = getWish(db, x.wishId);
          return (row ? seen([row]) : []).filter((s) => s.gift)
            .map((s) => ({ wish: wish(s), celebration: celebrationRef(x.celebrationId), on: x.on, named: x.named }));
        }),
        // Delivered and waiting for an answer, for the viewer and the kids they are a parent of; kids answer none.
        questions: viewer.role === 'kid' ? [] : (() => {
          const mine = [...people().values()].filter((p) => answersFor(db, viewer, p));
          const byId = new Map(mine.map((p) => [p.id, p]));
          return questionsFor(db, mine.map((p) => p.id)).filter((q) => q.state === 'open' && isDelivered(q, instant)).sort(byMorning)
            .map((q) => ({ id: q.id, text: q.text, on: today(cfg.timezone, new Date(q.deliverAt)), for: { id: q.personId, name: byId.get(q.personId)!.name } }));
        })(),
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
        // The viewer's own "Remind me" about them (never anyone else's; null on one's own page).
        reminder: reminderFor(p.id),
        // Only for someone giving to them: absent (never read) for the person and for kids.
        ...(givesTo(viewer, p.id) ? { questions: questionsOf(p.id) } : {}),
        ...(seesIdeas(viewer, p.id) ? { ideas: ideasOf(p.id) } : {}),
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
    /**
     * A celebration's draw as the viewer may see it: who is in it, its settings, "4 of 6 opened"; the exclusions for
     * its host only; the viewer's own receiver once they opened theirs; every pair, for the participants and the host,
     * only from the reveal date on. Nothing in it depends on whom anyone else drew before that.
     */
    draw: (celebrationId: string): Viewed<api.Draw> => {
      const c = mustGetCelebration(db, celebrationId);
      const d = latestDraw(db, c.id);
      if (!d) throw new Refused(404, 'this celebration has no draw');
      const ps = participantsOf(db, [d.id]);
      const byId = new Map(ps.map((p) => [p.id, p]));
      // A guest (M4) by their name, with their participant id: they have no page in the household.
      const pref = (pid: string) => {
        const p = byId.get(pid);
        if (p?.kind === 'guest' && p.guestId) { const name = guestNames().get(p.guestId); return name ? { id: p.id, name } : null; }
        return p?.personId ? ref(p.personId) : null;
      };
      const manages = managesDraw(viewer, c, hostRoleOf(db, c));
      const mine = ps.find(isMine);
      const revealed = revealedNow(db, c, d, now);
      // A row that does not open with the keys here (a lost or rotated key) is only its own giver's problem.
      const own = mine?.openedAt && d.drawnAt ? openOwn(db, ring(), d, mine) : null;
      const receiver = own === 'unreadable' ? null : own;
      const pairs = revealed && d.drawnAt && (mine || manages)
        ? [...openAll(db, ring(), d)].map(([g, r]) => ({ giver: pref(g), receiver: r ? pref(r) : null })).sort((a, b) => byName(a.giver, b.giver))
        : null;
      return answer({
        celebrationId: c.id, year: d.year, on: drawDay(c, d),
        budgetMinor: d.budgetMinor, kidsDraw: d.kidsDraw === 1, notLastYear: d.notLastYear === 1,
        drawTogetherAt: d.drawTogetherAt, revealOn: d.revealOn,
        people: ps.filter((p) => p.kind === 'person').map((p) => ref(p.personId!)).filter((r): r is api.PersonRef => r !== null).sort(byName),
        guests: ps.filter((p) => p.kind === 'guest' && p.guestId).map((p) => guestNames().get(p.guestId!) ?? '').filter(Boolean).sort((a, b) => a.localeCompare(b)),
        exclusions: manages
          ? exclusionsOf(db, d.id).map((e) => [pref(e.a), pref(e.b)].sort(byName)).filter((x): x is [api.PersonRef, api.PersonRef] => x.every(Boolean))
            .sort((x, y) => byName(x[0], y[0]) || byName(x[1], y[1]))
          : null,
        drawn: d.drawnAt !== null, redrawnAt: d.redrawnAt,
        opened: ps.filter((p) => p.openedAt).length, total: ps.length,
        over: dayHasCome(c, d, now), revealed,
        canManage: manages,
        canRedraw: manages && canRedraw(db, viewer, c, d, now),
        mine: mine ? {
          opened: mine.openedAt !== null, canOpen: mine.openedAt === null && opensNow(d, instant), receiver: receiver ? pref(receiver) : null,
          receiverGuest: receiver ? byId.get(receiver)?.kind === 'guest' : false,
          unreadable: own === 'unreadable',
        } : null,
        pairs,
      });
    },
    /** A question the viewer asked or may see (404 otherwise). */
    question: (id: string): Viewed<api.AskedQuestion> => {
      const q = getQuestion(db, id);
      if (!q || !seesQuestion(db, viewer, q, instant)) throw new Refused(404, 'no such question');
      return answer(asked(q));
    },
    idea: (id: string): Viewed<api.Idea> => {
      const i = getIdea(db, id);
      if (!i || !seesIdeas(viewer, i.personId)) throw new Refused(404, 'no such idea');
      return answer(ideasOf(i.personId).find((x) => x.id === id)!);
    },
    links: (): Viewed<api.GuestLinks> => {
      // Never a token, never a link for the viewer themselves; revoked ones stay listed (dated).
      return answer({ links: linksFor(db, viewer).map(link) });
    },
    link: (id: string): Viewed<api.GuestLink> => answer(link(mustLink(id))),
    /** A link just made, with its address: shown this once (data.ts hands the token's url over, never a route). */
    linkMade: (id: string, url: string): Viewed<api.GuestLinkMade> => answer({ link: link(mustLink(id)), url: str(url) }),
    importPlan: (p: Plan): Viewed<api.ImportPlan> => answer({
      rows: p.rows, wishes: p.wishes, claims: p.claims, ready: p.ready,
      people: p.people.map((x) => ({ name: x.name, personId: x.personId, status: x.status, rows: x.rows })),
      occasions: p.occasions.map((x) => ({ name: x.name, celebrationId: x.celebrationId, status: x.status, rows: x.rows })),
      buyers: p.buyers.map((x) => ({ name: x.name, personId: x.personId, rows: x.rows })),
      skipped: p.skipped.map((x) => ({ row: x.row, reason: x.reason })),
      warnings: p.warnings.map((x) => ({ row: x.row, kind: x.kind })),
    }),
    /** The viewer's notices (ADR 0010), newest first. */
    notices: (): Viewed<api.Notices> => {
      const ns = noticesOf(db, viewer.id).flatMap(noticeOf);
      return answer({ notices: ns, unread: ns.filter((n) => !n.read).length });
    },
    /** Whether this server sends pushes, and its public key for the browser's subscription. */
    push: (): Viewed<api.PushInfo> => {
      const v = cfg.egress === false ? null : usableVapid({ vapidKey: cfg.vapidKey ?? null });
      return answer({ available: v !== null, publicKey: v ? v.publicKey.toString('base64url') : null });
    },
    /** One received gift's thank-you entry (after writing it): the same as in `home`. */
    thanks: (wishId: string): Viewed<api.Thanks> => {
      const x = thanksList().find((y) => y.wish.id === wishId);
      if (!x) throw new Refused(404, 'no such wish');
      return answer(x);
    },
    /** A shop page's proposal for a wish (ADR 0011): nothing stored, the person's to change and save. */
    preview: (p: Preview): Viewed<api.LinkPreview> => answer({
      link: str(p.link), name: p.name === null ? null : str(p.name), priceMinor: p.priceMinor,
      pagePrice: p.pagePrice ? { currency: str(p.pagePrice.currency), amountMinor: p.pagePrice.amountMinor } : null,
    }),
    importDone: (d: { wishes: number; claims: number; skipped: number }): Viewed<api.ImportDone> => answer({ wishes: d.wishes, claims: d.claims, skipped: d.skipped }),
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

/**
 * What a guest sees (ADR 0009): only what their link reaches (one person's listed wishes; a draw guest's own person's
 * list for the celebration, once opened), as a giver sees it but with nobody's name on a gift (their own claims marked
 * mine), that person's sizes, likes and "please no" (read-only), questions without askers (theirs marked mine), no
 * ideas, nothing else of the household.
 */
export function guestViewFor(db: Db, cfg: Pick<Config, 'mode' | 'timezone' | 'sealingKey' | 'sealingKeyPrevious'>, l: GuestLink, owner: object) {
  const answer = marker(owner);
  const instant = new Date();
  const now = today(cfg.timezone, instant);
  const ring = keyring(cfg);
  let cal: ReturnType<typeof calendarOf> | undefined;
  const calendar = () => (cal ??= calendarOf(db));
  const reachNow = () => reachOf(db, l, ring);

  const gift = (w: Wish, g: Gifts): api.Gift => {
    const byTime = <T extends { createdAt: string; id: string }>(xs: T[]) => [...xs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const claimed = g.claims.reduce((n, c) => n + c.quantity, 0);
    const mine = g.group ? undefined : g.claims.find((c) => c.guestId === l.id);
    return {
      claimed, left: g.group ? 0 : Math.max(0, w.quantity - claimed), given: fullyGiven(w, g),
      claims: byTime(g.claims).map((c) => ({ giver: null, guest: null, imported: c.imported === 1, quantity: c.quantity, state: c.state, mine: c.guestId === l.id })),
      group: g.group ? {
        organizer: null, targetMinor: g.group.targetMinor, state: g.group.state, totalMinor: g.shares.reduce((n, x) => n + x.amountMinor, 0),
        givers: byTime(g.shares).map(() => ({ giver: null, mine: false })), myShareMinor: null, canManage: false,
      } : null,
      mine: mine ? (() => {
        const occ = occasionOf(w, mine.givenOn ?? now, calendar());
        if (mine.occasionOn && (!occ.date || mine.occasionOn > occ.date)) occ.date = mine.occasionOn;
        return { state: mine.state, named: false, over: isOver(w, mine, calendar(), now), celebrationId: occ.celebrationId, forDate: occ.date };
      })() : null,
    };
  };
  const wishOf = (w: Wish, g: Gifts): api.Wish => ({
    id: w.id, personId: w.personId, celebrationId: w.celebrationId, name: w.name, link: w.link, priceMinor: w.priceMinor,
    quantity: w.quantity, note: w.note, mostWanted: w.mostWanted === 1, state: w.state, addedBy: null,
    createdAt: w.createdAt, updatedAt: w.updatedAt, canEdit: false, canApprove: false, gift: gift(w, g),
  });
  const wishes = (reach: ReturnType<typeof reachNow>) => {
    const rows = reach ? wishesOf(db, [reach.personId]).filter((w) => reaches(reach, w)) : [];
    const gifts = giftsOf(db, rows.map((w) => w.id));
    return rows.map((w) => ({ w, g: gifts.get(w.id) ?? NO_GIFTS })).filter(({ w, g }) => !fullyGiven(w, g))
      .sort((a, b) => a.w.position - b.w.position || a.w.createdAt.localeCompare(b.w.createdAt)).map(({ w, g }) => wishOf(w, g));
  };
  const questions = (reach: ReturnType<typeof reachNow>) => {
    if (!reach) return [];
    const wishName = (id: string) => { const w = getWish(db, id); return w && reaches(reach, w) ? w.name : null; };
    return questionsFor(db, [reach.personId])
      .filter((q) => isAsker(q, { guestId: l.id }) || (isDelivered(q, instant) && (q.state === 'open' || q.state === 'answered')))
      .sort(byMorning).map((q) => askedOf(q, isAsker(q, { guestId: l.id }), instant, cfg.timezone, wishName));
  };
  const one = (q: Question | undefined, reach: ReturnType<typeof reachNow>) => {
    const found = q && questions(reach).find((x) => x.id === q.id);
    if (!found) throw new Refused(404, 'no such question');
    return found;
  };

  return {
    page: (): Viewed<api.GuestPage> => {
      const reach = reachNow();
      const place = l.kind === 'draw' ? guestPlace(db, l.id) : null;
      const ps = place ? participantsOf(db, [place.d.id]) : [];
      const own = place?.me.openedAt && place.d.drawnAt ? openOwn(db, ring, place.d, place.me) : null;
      const receiver = own && own !== 'unreadable' ? ps.find((p) => p.id === own) : undefined;
      const person = reach ? mustGetPerson(db, reach.personId) : null;
      return answer({
        link: l.id, kind: l.kind, name: l.guestName, currency: currency(db),
        person: person ? { id: person.id, name: person.name } : null,
        // A godmother buying clothes needs the sizes: the reached person's only (a draw guest's once opened).
        profile: person ? profile(getProfile(db, person.id)) : null,
        celebration: place ? { id: place.c.id, name: place.c.name, date: drawDay(place.c, place.d), place: place.c.place, poster: place.c.poster } : null,
        draw: place ? {
          drawn: place.d.drawnAt !== null, opened: place.me.openedAt !== null, canOpen: place.me.openedAt === null && opensNow(place.d, instant),
          total: ps.length, openedCount: ps.filter((p) => p.openedAt).length, budgetMinor: place.d.budgetMinor, drawTogetherAt: place.d.drawTogetherAt,
          receiverGuest: receiver?.kind === 'guest' && receiver.guestId ? guestNamesOf(db).get(receiver.guestId) ?? null : null,
        } : null,
        wishes: wishes(reach),
        questions: questions(reach),
        lastDay: lastDayOf(db, l),
        // A link given a new address says so, and when the earlier address was last used (review R-1): a peek by
        // whoever held it in between shows to the guest.
        reissued: l.reissuedAt ? { on: dayOfInstant(cfg.timezone, l.reissuedAt), count: l.reissueCount, earlierLastUsedOn: l.earlierLastUsedAt ? dayOfInstant(cfg.timezone, l.earlierLastUsedAt) : null } : null,
      });
    },
    /** One wish the guest reaches (404 otherwise). */
    wish: (id: string): Viewed<api.Wish> => {
      const reach = reachNow();
      const w = getWish(db, id);
      if (!w || !reaches(reach, w)) throw new Refused(404, 'no such wish');
      return answer(wishOf(w, giftsOf(db, [w.id]).get(w.id) ?? NO_GIFTS));
    },
    question: (id: string): Viewed<api.AskedQuestion> => answer(one(getQuestion(db, id), reachNow())),
  };
}
