// The one door routes have to the household's data (ADR 0003): domain operations with the database bound in, and the
// view layer for every answer. Routes never get a `Db`, so no route can query a table, reach the SQLite client or
// serialize a row; test/architecture.test.ts keeps src/routes to this module, the validators and types.
//
// Whoever acts or views is always the request's person: every operation here takes the router's request (src/router.ts)
// and finds the person on it, never a person a route hands in. Household operations return ids or nothing; the view
// helpers build the answers from those ids, bound to that request. (The sign-in steps' lookups, auth.findInvite,
// invitee, findPasskey and credentialsOf, do hand rows to routes/auth.ts; none of them can leave but through a view
// answer.) Admin-only operations check the role here too, not only in the route (defence in depth).
import type { Config } from './config';
import type { Db } from './db/open';
import { callerOf } from './auth/hook';
import { createInvite, findInvite } from './auth/invites';
import { credentialsOf, enrol, findPasskey, invitePersonOf, removePasskey, resetPasskeys, RESET_FRESH_MINUTES, usedPasskey } from './auth/passkeys';
import { createSession, endAllSessions, endSession, isFresh, SESSION_COOKIE } from './auth/sessions';
import type { NewCredential } from './auth/webauthn';
import { addCelebration, editCelebration, getCelebration, removeCelebration, settlePastCelebrations, type CelebrationInput } from './celebrations/celebrations';
import { today } from './celebrations/dates';
import { Refused } from './errors';
import {
  addPerson, currency, editPerson, hasPasskey, managesKid, mustGetPerson, removePerson, setCurrency, setManagers, setupNeeded,
  type Person, type PersonInput,
} from './household/people';
import { chipIn, claimWish, editGroup, endGroup, refreshRevealed, releaseImported, setClaimState, setNamed, startGroup, unclaimWish, withdrawShare, type ClaimState, type GroupState } from './gifts/gifts';
import { setProfile, type ProfileInput } from './household/profile';
import {
  auditMoves, beforePersonRemoved, veilCelebration, checkCelebrationMove, checkCelebrationRemoval, checkPeopleChange, createDraw, dropLeavers, editDraw, openDraw,
  removeDraw, runDraw, type DrawInput,
} from './draws/draws';
import { keyring } from './draws/sealed';
import { asDb } from './db/open';
import { clientKey } from './identity';
import { fastifyRequestOf, type Req } from './router';
import { isId } from './validate';
import { guestViewFor, linkAnswer, publicViewFor, viewFor, type ListFor } from './view/view';
import { answerQuestion, answerWithWish, ask, askersOf, declineQuestion, removeQuestion } from './questions/questions';
import { addIdea, removeIdea } from './ideas/ideas';
import {
  checkMemberName, createShareLink, drawLinksOf, drawLinkWriter, settleGuestClaims, endDeviceSessions, forgetLink, getLink, GUEST_COOKIE, GUEST_DAYS, reissueLink, guestGiving, linkUrl, reachOf, revokeLink, sameName, setGuestName,
  startGuestSession, type GuestLink,
} from './guests/guests';
import { addGuest, guestLeaves, openDrawAsGuest } from './draws/draws';
import { claimFor, setClaimStateFor, unclaimFor } from './gifts/gifts';
import { applyImport, dryRun, type ImportInput } from './import/import';
import { createEgress, type Egress } from './net/egress';
import { drawStamps, drawsChanged, markRead, type NoticeKind } from './notices/notices';
import { morning } from './jobs/morning';
import { Pusher, subscribe, unsubscribe, type SubscriptionInput } from './push/push';
import { usableVapid } from './push/keys';
import { thankRecipients, writeThanks } from './thanks/thanks';
import { previewLink } from './wishes/preview';
import * as t from './db/schema';
import { and, eq } from 'drizzle-orm';
import { addWish, approveWish, declineWish, editWish, orderWishes, removeWish, type WishInput } from './wishes/wishes';

export type { CelebrationInput } from './celebrations/celebrations';
export type { WishInput } from './wishes/wishes';
export type { ClaimState, GroupState } from './gifts/gifts';
export type { DrawInput } from './draws/draws';
export { MAX_EXCLUSIONS } from './draws/draws';
export { MAX_WISHES } from './wishes/wishes';
export type { ImportInput } from './import/import';
export { MAX_CSV } from './import/import';
export { RESET_FRESH_MINUTES } from './auth/passkeys';

/** What the facade sends out (ADR 0010, 0011): the push queue and the one egress client. Tests pass their own. */
export interface Outside { pusher?: Pusher; egress?: Egress }

/** "Add from a link" (ADR 0011): per person, at most this many pages an hour and one at a time; four at once in all. */
export const PREVIEWS_AN_HOUR = 30;
const PREVIEWS_AT_ONCE = 4;

export function dataFor(cfg: Config, db: Db, outside: Outside = {}) {
  const pusher = outside.pusher ?? new Pusher(db, null);
  const egress = outside.egress ?? createEgress({ enabled: cfg.egress });
  /** The person behind a request (the auth hook has refused requests without one, except on public routes). */
  const me = (r: Req): Person => {
    const c = fastifyRequestOf(r).caller;
    if (!c) throw new Refused(401, 'sign in required');
    return c.person;
  };
  const cookie = (r: Req) => fastifyRequestOf(r).cookies?.[SESSION_COOKIE];
  const publicView = (r: Req) => publicViewFor(db, cfg, fastifyRequestOf(r));
  const admin = (r: Req): Person => {
    const p = me(r);
    if (p.role !== 'admin') throw new Refused(403, 'admins only');
    return p;
  };
  const day = () => today(cfg.timezone);
  /**
   * After a change to gifts, wishes, celebrations or people, what the household has received is rebuilt here, in the
   * changing request (gifts/gifts.ts `revealed`): a person's reading requests then do the same work whatever is
   * hidden from them.
   */
  const changed = <T>(v: T): T => { refreshRevealed(db, day()); return v; };
  /** After a change to a draw or a link: a guest's claims they can no longer manage go (review M1), then `changed`. */
  const settled = <T>(v: T): T => { settleGuestClaims(db, keyring(cfg)); return changed(v); };
  const fresh = (r: Req, minutes?: number) => {
    const s = fastifyRequestOf(r).caller?.session;
    if (!s || !isFresh(s, new Date(), minutes)) throw new Refused(403, 'sign in again to do this');
  };

  /** The guest behind a guest route's request (the auth hook has refused requests without one). */
  const guestOf = (r: Req): GuestLink => {
    const g = fastifyRequestOf(r).guest;
    if (!g) throw new Refused(401, 'this link is unknown, used or expired');
    return g;
  };
  /** Guests reach Keepsake only standalone until HomersLab's edge lets them in (Homeward #317). */
  const homersLabWaits = () => { if (cfg.mode === 'homerslab') throw new Refused(409, 'guest links work once HomersLab lets guests in'); };
  const viewOf = (r: Req) => viewFor(db, cfg, me(r), fastifyRequestOf(r));

  /** Notices (ADR 0010): made in the changing request, pushed from the queue after it. */
  // The request only hands over what to tell; who is told, and the push, are the queue's (PR #12 review, L6).
  // One durable row per change; who is told is found at the tick (PR #12 review, N-M1).
  const tellLater = (kind: NoticeKind, subjectId: string, o?: { again?: boolean; people?: string[] }) => pusher.tell({ kind, subjectId, day: day(), people: o?.people, again: o?.again });
  pusher.resolve('answered', (id) => askersOf(db, id));
  pusher.resolve('thanked', (id, on) => thankRecipients(db, id, on));
  /** A change that may draw names, draw them again or clear them: the draw's people (but whoever did it) are told. */
  // The change and its pending row in one transaction: kept or lost together (PR #12 third review, L3).
  const atomically = <T>(f: () => T): T => db.transaction(() => f());
  // A refused draw keeps what it wrote before refusing (its try, its audit row), as it did outside a transaction; any
  // other failure, and one writing the pending rows, undoes everything (issue #13, 2).
  const drawsTold = <T>(r: Req, f: () => T): T => {
    let refused: { e: Refused } | undefined;
    const v = atomically(() => {
      const before = drawStamps(db);
      let out: T;
      try { out = f(); } catch (e) {
        if (!(e instanceof Refused)) throw e;
        refused = { e };
        return undefined as T;
      }
      const by = me(r).id;
      for (const d of drawsChanged(db, before)) tellLater('draw', d.celebrationId, { again: true, people: d.people.filter((p) => p !== by) });
      return out;
    });
    if (refused) throw refused.e;
    return v;
  };
  const previews = { inFlight: new Set<string>(), all: 0, recent: new Map<string, number[]>() };

  return {
    /** The view layer for the request's person. One-off celebrations whose day has passed let go of their wishes first (ADR 0007). */
    view: (r: Req) => {
      const viewer = me(r);
      if (settlePastCelebrations(db, day())) changed(0);
      return viewFor(db, cfg, viewer, fastifyRequestOf(r));
    },
    /** Answers that need no viewer, built for this request. */
    publicView,
    /** GET /auth/session: who this browser is, if anyone. */
    session: (r: Req) => {
      const c = callerOf(cfg, db, fastifyRequestOf(r));
      return c && c !== 'no-role' ? publicView(r).signedIn(c.person.id) : publicView(r).signedOut(cfg.mode === 'standalone' && setupNeeded(db));
    },
    /** The request's person's id and role (for the routes' own checks). */
    me: (r: Req): Readonly<Pick<Person, 'id' | 'role'>> => { const p = me(r); return Object.freeze({ id: p.id, role: p.role }); },
    /** Refuses unless this session signed in with a passkey within `minutes` (an old, stolen cookie cannot). */
    fresh,
    /** The challenge store's key for a request (identity.clientKey, the rate limit's too). */
    clientKey: (r: Req) => { const req = fastifyRequestOf(r); return clientKey(cfg, req.socket.remoteAddress, req.headers); },
    /** The `for` query: a celebration's list, `any`, or nothing (every wish). */
    listFor: (q: unknown): ListFor => {
      const v = (q as { for?: unknown } | undefined)?.for;
      if (v === undefined) return null;
      if (v === 'any') return 'any';
      if (!isId(v) || !getCelebration(db, v)) throw new Refused(400, 'for: a celebration\'s id, or any');
      return { celebration: v };
    },
    auth: {
      findInvite: (token: unknown) => findInvite(db, token),
      invitee: (token: unknown) => { const i = findInvite(db, token); return i ? invitePersonOf(db, i) ?? null : null; },
      /** A one-time link from the request's person: for another device of their own, or (admins) for someone's first passkey. */
      invite: (r: Req, kind: 'self' | 'admin', personId: string) => {
        const p = kind === 'admin' ? admin(r) : me(r);
        if (kind === 'self' && personId !== p.id) throw new Refused(403, 'not allowed');
        fresh(r);
        return linkAnswer(fastifyRequestOf(r), createInvite(db, cfg, { kind, personId: mustGetPerson(db, personId).id, createdBy: p.id }));
      },
      credentialsOf: (personId: string) => credentialsOf(db, personId),
      enrol: (o: { inviteId: string; name?: string; newPersonId?: string }, cred: NewCredential, label: string) => enrol(db, cfg, o, cred, label),
      findPasskey: (id: string) => findPasskey(db, id),
      usedPasskey: (id: string, counter: number) => usedPasskey(db, id, counter),
      /** A sign-in: this browser's earlier session ends, a new one starts. Returns the new cookie's token. */
      signIn: (r: Req, personId: string, passkeyId: string) => {
        endSession(db, cookie(r));
        // A household sign-in ends this browser's guest sessions (review L-2); the route clears the cookie.
        endDeviceSessions(db, fastifyRequestOf(r).cookies?.[GUEST_COOKIE]);
        return createSession(db, personId, passkeyId).token;
      },
      endThisSession: (r: Req) => endSession(db, cookie(r)),
      endMySessions: (r: Req) => endAllSessions(db, me(r).id),
      removeMyPasskey: (r: Req, id: string) => removePasskey(db, me(r).id, id),
      /** A kid's parent or an admin ends someone's sessions. */
      endSessionsOf: (r: Req, personId: string) => {
        const p = mustGetPerson(db, personId);
        const by = me(r);
        if (by.role !== 'admin' && !managesKid(db, by, p)) throw new Refused(403, 'a kid\'s parent or an admin only');
        endAllSessions(db, p.id);
      },
      /** An admin with a passkey sign-in of the last RESET_FRESH_MINUTES resets someone's passkeys. */
      resetPasskeys: (r: Req, personId: string) => {
        const by = admin(r);
        fresh(r, RESET_FRESH_MINUTES);
        resetPasskeys(db, by.id, personId);
      },
    },
    people: {
      /** A name like a guest's the admin sees is refused until confirmed (review L-b). */
      add: (r: Req, i: PersonInput, confirmed: boolean) => {
        const by = admin(r);
        if (!confirmed) checkMemberName(db, by, i.name);
        return addPerson(db, i).id;
      },
      edit: (r: Req, id: string, patch: Partial<PersonInput>, confirmed: boolean) => {
        const by = admin(r);
        if (patch.name !== undefined && !confirmed && !sameName(mustGetPerson(db, id).name, patch.name)) checkMemberName(db, by, patch.name, id);
        editPerson(db, id, patch);
      },
      /** Someone in a drawn draw leaves it first, under the re-draw rules (draws/draws.ts), in the same transaction. */
      remove: (r: Req, id: string) => drawsTold(r, () => {
        const by = admin(r);
        db.transaction((tx) => {
          beforePersonRemoved(asDb(tx), by, id, day(), keyring(cfg));
          removePerson(asDb(tx), id, by.id);
        });
        settled(0);
      }),
      setManagers: (r: Req, kidId: string, ids: string[]) => { admin(r); setManagers(db, kidId, ids); },
      setCurrency: (r: Req, code: string | null) => { admin(r); setCurrency(db, code); },
      hasPasskey: (id: string) => hasPasskey(db, mustGetPerson(db, id).id),
      /** Whether the request's person manages this kid (as a set manager, or as an admin when none is set). */
      managesKid: (r: Req, kidId: string) => managesKid(db, me(r), mustGetPerson(db, kidId)),
      setProfile: (r: Req, personId: string, i: ProfileInput) => { setProfile(db, me(r), personId, i); },
    },
    wishes: {
      add: (r: Req, personId: string, i: WishInput) => changed(addWish(db, me(r), personId, i).id),
      // A wish moved out of a draw guest's reach takes their only-made claim along (review L-a).
      edit: (r: Req, id: string, patch: Partial<WishInput>) => { editWish(db, me(r), id, patch); settled(0); },
      remove: (r: Req, id: string) => changed(removeWish(db, me(r), id)),
      approve: (r: Req, id: string) => { approveWish(db, me(r), id); changed(0); },
      decline: (r: Req, id: string) => changed(declineWish(db, me(r), id)),
      order: (r: Req, personId: string, ids: string[]) => orderWishes(db, me(r), personId, ids),
    },
    /** What givers do (gifts/gifts.ts), as the request's person: each returns the wish's id for the view layer. */
    gifts: {
      claim: (r: Req, wishId: string, quantity: number) => changed(claimWish(db, me(r), wishId, quantity).id),
      setState: (r: Req, wishId: string, state: ClaimState) => changed(setClaimState(db, me(r), wishId, state, day()).id),
      unclaim: (r: Req, wishId: string) => changed(unclaimWish(db, me(r), wishId)),
      releaseImported: (r: Req, wishId: string) => { releaseImported(db, me(r), wishId); changed(0); },
      setNamed: (r: Req, wishId: string, named: boolean) => changed(setNamed(db, me(r), wishId, named, day()).id),
      startGroup: (r: Req, wishId: string, targetMinor: number) => changed(startGroup(db, me(r), wishId, targetMinor).id),
      editGroup: (r: Req, wishId: string, patch: { targetMinor?: number; state?: GroupState }) => changed(editGroup(db, me(r), wishId, patch, day()).id),
      endGroup: (r: Req, wishId: string) => changed(endGroup(db, me(r), wishId)),
      chipIn: (r: Req, wishId: string, amountMinor: number) => changed(chipIn(db, me(r), wishId, amountMinor).id),
      withdraw: (r: Req, wishId: string) => changed(withdrawShare(db, me(r), wishId)),
    },
    /** A celebration's draw (draws/draws.ts), as the request's person: each returns the celebration's id for the view layer. */
    draws: {
      create: (r: Req, celebrationId: string, i: DrawInput) => createDraw(db, me(r), celebrationId, i, day()),
      edit: (r: Req, celebrationId: string, patch: Partial<DrawInput>) => drawsTold(r, () => settled(editDraw(db, me(r), celebrationId, patch, day(), keyring(cfg)))),
      remove: (r: Req, celebrationId: string) => settled(removeDraw(db, me(r), celebrationId, day())),
      run: (r: Req, celebrationId: string) => drawsTold(r, () => settled(runDraw(db, me(r), celebrationId, day(), keyring(cfg)))),
      open: (r: Req, celebrationId: string) => openDraw(db, me(r), celebrationId, new Date(), keyring(cfg)),
    },
    /** Anonymous questions (questions/questions.ts): each returns an id for the view layer, never the asker. */
    questions: {
      ask: (r: Req, personId: string, text: string) => { const p = me(r); return ask(db, cfg.timezone, { personId: p.id, role: p.role }, personId, text); },
      // Its asker (someone of the household) is told it was answered: questions.ts hands the id to the notice only.
      answer: (r: Req, id: string, text: string) => atomically(() => { answerQuestion(db, me(r), id, text, new Date(), () => tellLater('answered', id)); }),
      decline: (r: Req, id: string) => atomically(() => { declineQuestion(db, me(r), id, new Date(), () => tellLater('answered', id)); }),
      withWish: (r: Req, id: string, i: WishInput) => changed(atomically(() => answerWithWish(db, me(r), id, i, new Date(), () => tellLater('answered', id)))),
      remove: (r: Req, id: string) => removeQuestion(db, me(r), id),
    },
    ideas: {
      add: (r: Req, personId: string, text: string) => addIdea(db, me(r), personId, text),
      remove: (r: Req, id: string) => { removeIdea(db, me(r), id); },
    },
    /** Guest links (guests/guests.ts): a new link's address is built here and shown once. */
    links: {
      share: (r: Req, personId: string, label: string) => {
        homersLabWaits();
        const made = createShareLink(db, me(r), personId, label);
        return viewOf(r).linkMade(made.id, linkUrl(cfg, made.token));
      },
      /** A personal draw link: the guest joins the draw in the same transaction (a re-draw once drawn). */
      invite: (r: Req, celebrationId: string, name: string) => {
        const out: { id?: string; token?: string } = {};
        homersLabWaits();
        drawsTold(r, () => { addGuest(db, me(r), celebrationId, drawLinkWriter(me(r), celebrationId, name, out), day(), keyring(cfg)); settled(0); });
        return viewOf(r).linkMade(out.id!, linkUrl(cfg, out.token!));
      },
      revoke: (r: Req, id: string) => drawsTold(r, () => { revokeLink(db, me(r), id, (linkId) => guestLeaves(db, linkId)); settled(0); }),
      /** A new address for a link (review M-b): the same guest, a new token shown once. */
      reissue: (r: Req, id: string) => {
        // A link left from a standalone past waits for the edge too (Gate routes L5).
        homersLabWaits();
        const made = reissueLink(db, me(r), id);
        return viewOf(r).linkMade(made.id, linkUrl(cfg, made.token));
      },
    },
    /** The sheet import (import/import.ts): admins only, checked there too. */
    imports: {
      dryRun: (r: Req, i: ImportInput) => viewOf(r).importPlan(dryRun(db, admin(r), i)),
      apply: (r: Req, i: ImportInput) => viewOf(r).importDone(changed(applyImport(db, admin(r), i))),
    },
    /** What a guest does (ADR 0009), as the request's guest: only on what their link reaches. */
    guest: {
      /** Read again: a change in this request (their name) shows in its answer. */
      view: (r: Req) => guestViewFor(db, cfg, getLink(db, guestOf(r).id) ?? guestOf(r), fastifyRequestOf(r)),
      /**
       * A link's token for a session, on one device (review N2): the cookie's token, its age, and the page for that
       * guest. The browser's own guest session of that link goes on; another exchange of an opened link is refused.
       */
      start: (r: Req, token: unknown) => {
        homersLabWaits();
        // The browser's own household session, if any: one the link is not for is refused (H1, defence in depth).
        const req = fastifyRequestOf(r);
        const c = callerOf(cfg, db, req);
        const by = c === 'no-role' ? { id: '', role: 'kid' as const } : c?.person ?? null;
        const now = new Date();
        const s = startGuestSession(db, token, day(), now, by, req.cookies?.[GUEST_COOKIE]);
        // The device cookie outlives any one session: it is how this browser opens its links again (review M-a).
        return { cookie: s.device, maxAge: GUEST_DAYS * 86_400, page: guestViewFor(db, cfg, s.link, req).page() };
      },
      signOut: (r: Req) => forgetLink(db, fastifyRequestOf(r).cookies?.[GUEST_COOKIE], guestOf(r).id),
      setName: (r: Req, name: string) => { setGuestName(db, guestOf(r), name); },
      openDraw: (r: Req) => openDrawAsGuest(db, guestOf(r).id, new Date(), keyring(cfg)),
      claim: (r: Req, wishId: string, quantity: number) => {
        const g = guestOf(r);
        return changed(claimFor(db, guestGiving(db, g, keyring(cfg), wishId), { guestId: g.id }, quantity).id);
      },
      setState: (r: Req, wishId: string, state: ClaimState) => {
        const g = guestOf(r);
        return changed(setClaimStateFor(db, guestGiving(db, g, keyring(cfg), wishId), { guestId: g.id }, state, day()).id);
      },
      unclaim: (r: Req, wishId: string) => {
        const g = guestOf(r);
        changed(unclaimFor(db, guestGiving(db, g, keyring(cfg), wishId), { guestId: g.id }));
      },
      ask: (r: Req, text: string) => {
        const g = guestOf(r);
        const reach = reachOf(db, g, keyring(cfg));
        if (!reach) throw new Refused(409, 'open your draw first: then you can ask your person');
        return ask(db, cfg.timezone, { guestId: g.id }, reach.personId, text);
      },
    },
    /** Thank-yous (thanks/thanks.ts): the givers are told; who they are never comes back. Returns the wish's id. */
    thanks: {
      say: (r: Req, wishId: string, text: string) => {
        atomically(() => tellLater('thanked', writeThanks(db, me(r), wishId, text, day())));
        return wishId;
      },
    },
    /** Notices and "Remind me" (ADR 0010): the caller's own only. */
    notices: {
      read: (r: Req) => markRead(db, me(r).id),
      /** Reminded `days` before each of this person's celebrations, or not (null). Never about oneself. */
      remind: (r: Req, personId: string, days: number | null) => {
        const by = me(r);
        const p = mustGetPerson(db, personId);
        if (p.id === by.id) throw new Refused(403, 'your own celebrations remind you a week before');
        if (days === null) db.delete(t.reminder).where(and(eq(t.reminder.personId, by.id), eq(t.reminder.aboutId, p.id))).run();
        else db.insert(t.reminder).values({ personId: by.id, aboutId: p.id, days }).onConflictDoUpdate({ target: [t.reminder.personId, t.reminder.aboutId], set: { days } }).run();
      },
      /** The morning batch (jobs/morning.ts), from the scheduler: who was told is woken in the push queue. */
      morning: (now: Date) => pusher.wake(morning(db, cfg, now)),
    },
    /** This device's Web Push subscription (push/push.ts): the caller's own; a standalone one ends with this session. */
    push: {
      subscribe: (r: Req, i: SubscriptionInput & { sync?: boolean }) => {
        if (!cfg.egress || !usableVapid(cfg)) throw new Refused(409, 'push is off on this server');
        const c = fastifyRequestOf(r).caller;
        subscribe(db, me(r).id, c?.session?.id ?? null, i, new Date(), { sync: i.sync });
      },
      unsubscribe: (r: Req, endpoint: string) => unsubscribe(db, me(r).id, endpoint),
    },
    /**
     * "Add from a link" (wishes/preview.ts, ADR 0011): a shop's page read through the egress client, for this person
     * only, PREVIEWS_AN_HOUR an hour and one at a time (four at once in all). Nothing is stored.
     */
    preview: async (r: Req, link: string) => {
      const p = me(r);
      const now = Date.now();
      const recent = (previews.recent.get(p.id) ?? []).filter((x) => now - x < 3_600_000);
      if (recent.length >= PREVIEWS_AN_HOUR || previews.inFlight.has(p.id) || previews.all >= PREVIEWS_AT_ONCE) throw new Refused(409, 'too many pages read: wait a few minutes');
      previews.recent.set(p.id, [...recent, now]);
      previews.inFlight.add(p.id);
      previews.all++;
      try {
        // KEEPSAKE_EGRESS=off turns it off here too, whatever client is in hand.
        return viewOf(r).preview(await previewLink(egress, cfg.egress ? cfg.shopHosts : [], link, currency(db)));
      } finally {
        previews.inFlight.delete(p.id);
        previews.all--;
      }
    },
    celebrations: {
      add: (r: Req, i: CelebrationInput) => changed(addCelebration(db, me(r), i).id),
      edit: (r: Req, id: string, patch: Partial<CelebrationInput>) => {
        // Someone in a drawn draw stays in the celebration until the draw changes; a draw not drawn yet lets them go.
        if (patch.people) checkPeopleChange(db, id, patch.people, day());
        // A drawn draw's day only moves later (review H2); a move is audited.
        const moved = checkCelebrationMove(db, me(r), id, patch, day());
        drawsTold(r, () => {
          editCelebration(db, me(r), id, patch);
          auditMoves(db, me(r), moved);
          if (patch.people) dropLeavers(db, id, patch.people);
          settled(0);
        });
      },
      /** A drawn draw before its day goes only under the re-draw rules. */
      remove: (r: Req, id: string) => {
        checkCelebrationRemoval(db, me(r), id, day());
        // Its draws go, but a veil of each secret one stays, so gifts made under it stay unnamed (ADR 0004).
        db.transaction((tx) => {
          veilCelebration(asDb(tx), id, day());
          // Its draw links go with it: their guests' claims are settled first (only-made ones go, review M1).
          // (A refused removal rolls this back with it.)
          settleGuestClaims(asDb(tx), keyring(cfg), drawLinksOf(asDb(tx), id));
          removeCelebration(asDb(tx), me(r), id);
        });
        return changed(undefined);
      },
    },
  };
}

export type Data = ReturnType<typeof dataFor>;
