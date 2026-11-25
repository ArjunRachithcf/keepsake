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
  addPerson, editPerson, hasPasskey, managesKid, mustGetPerson, removePerson, setCurrency, setManagers, setupNeeded,
  type Person, type PersonInput,
} from './household/people';
import { chipIn, claimWish, editGroup, endGroup, refreshRevealed, setClaimState, setNamed, startGroup, unclaimWish, withdrawShare, type ClaimState, type GroupState } from './gifts/gifts';
import { setProfile, type ProfileInput } from './household/profile';
import { clientKey } from './identity';
import { fastifyRequestOf, type Req } from './router';
import { isId } from './validate';
import { linkAnswer, publicViewFor, viewFor, type ListFor } from './view/view';
import { addWish, approveWish, declineWish, editWish, orderWishes, removeWish, type WishInput } from './wishes/wishes';

export type { CelebrationInput } from './celebrations/celebrations';
export type { WishInput } from './wishes/wishes';
export type { ClaimState, GroupState } from './gifts/gifts';
export { MAX_WISHES } from './wishes/wishes';
export { RESET_FRESH_MINUTES } from './auth/passkeys';

export function dataFor(cfg: Config, db: Db) {
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
  const fresh = (r: Req, minutes?: number) => {
    const s = fastifyRequestOf(r).caller?.session;
    if (!s || !isFresh(s, new Date(), minutes)) throw new Refused(403, 'sign in again to do this');
  };

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
      add: (r: Req, i: PersonInput) => { admin(r); return addPerson(db, i).id; },
      edit: (r: Req, id: string, patch: Partial<PersonInput>) => { admin(r); editPerson(db, id, patch); },
      remove: (r: Req, id: string) => changed(removePerson(db, id, admin(r).id)),
      setManagers: (r: Req, kidId: string, ids: string[]) => { admin(r); setManagers(db, kidId, ids); },
      setCurrency: (r: Req, code: string | null) => { admin(r); setCurrency(db, code); },
      hasPasskey: (id: string) => hasPasskey(db, mustGetPerson(db, id).id),
      /** Whether the request's person manages this kid (as a set manager, or as an admin when none is set). */
      managesKid: (r: Req, kidId: string) => managesKid(db, me(r), mustGetPerson(db, kidId)),
      setProfile: (r: Req, personId: string, i: ProfileInput) => { setProfile(db, me(r), personId, i); },
    },
    wishes: {
      add: (r: Req, personId: string, i: WishInput) => changed(addWish(db, me(r), personId, i).id),
      edit: (r: Req, id: string, patch: Partial<WishInput>) => { editWish(db, me(r), id, patch); changed(0); },
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
      setNamed: (r: Req, wishId: string, named: boolean) => changed(setNamed(db, me(r), wishId, named, day()).id),
      startGroup: (r: Req, wishId: string, targetMinor: number) => changed(startGroup(db, me(r), wishId, targetMinor).id),
      editGroup: (r: Req, wishId: string, patch: { targetMinor?: number; state?: GroupState }) => changed(editGroup(db, me(r), wishId, patch, day()).id),
      endGroup: (r: Req, wishId: string) => changed(endGroup(db, me(r), wishId)),
      chipIn: (r: Req, wishId: string, amountMinor: number) => changed(chipIn(db, me(r), wishId, amountMinor).id),
      withdraw: (r: Req, wishId: string) => changed(withdrawShare(db, me(r), wishId)),
    },
    celebrations: {
      add: (r: Req, i: CelebrationInput) => changed(addCelebration(db, me(r), i).id),
      edit: (r: Req, id: string, patch: Partial<CelebrationInput>) => { editCelebration(db, me(r), id, patch); changed(0); },
      remove: (r: Req, id: string) => changed(removeCelebration(db, me(r), id)),
    },
  };
}

export type Data = ReturnType<typeof dataFor>;
