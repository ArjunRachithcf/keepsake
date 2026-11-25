// The one door routes have to the household's data (ADR 0003): domain operations with the database bound in, and the
// view layer for every answer. Routes never get a `Db`, so no route can query a table, reach the SQLite client or
// serialize a row; test/architecture.test.ts keeps src/routes to this module, the validators and types.
//
// Whoever acts or views is always the request's person: every operation here takes the router's request (src/router.ts)
// and finds the person on it, never a person a route hands in. Operations return ids or nothing, never rows; the view
// helpers build the answers from those ids.
import type { Config } from './config';
import type { Db } from './db/open';
import { callerOf } from './auth/hook';
import { createInvite, findInvite } from './auth/invites';
import { credentialsOf, enrol, findPasskey, invitePersonOf, removePasskey, resetPasskeys, usedPasskey } from './auth/passkeys';
import { createSession, endAllSessions, endSession, isFresh, SESSION_COOKIE } from './auth/sessions';
import type { NewCredential } from './auth/webauthn';
import { addCelebration, editCelebration, getCelebration, removeCelebration, settlePastCelebrations, type CelebrationInput } from './celebrations/celebrations';
import { today } from './celebrations/dates';
import { Refused } from './errors';
import {
  addPerson, editPerson, hasPasskey, managesKid, mustGetPerson, removePerson, setCurrency, setManagers, setupNeeded,
  type Person, type PersonInput,
} from './household/people';
import { setProfile, type ProfileInput } from './household/profile';
import { clientKey } from './identity';
import { fastifyRequestOf, type Req } from './router';
import { isId } from './validate';
import { linkAnswer, publicViewFor, viewFor, type ListFor } from './view/view';
import { addWish, approveWish, declineWish, editWish, orderWishes, removeWish, type WishInput } from './wishes/wishes';

export type { CelebrationInput } from './celebrations/celebrations';
export type { WishInput } from './wishes/wishes';
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
  const publicView = publicViewFor(db, cfg);

  return {
    /** The view layer for the request's person. One-off celebrations whose day has passed let go of their wishes first (ADR 0007). */
    view: (r: Req) => {
      const viewer = me(r);
      settlePastCelebrations(db, today(cfg.timezone));
      return viewFor(db, cfg, viewer);
    },
    publicView,
    /** GET /auth/session: who this browser is, if anyone. */
    session: (r: Req) => {
      const c = callerOf(cfg, db, fastifyRequestOf(r));
      return c && c !== 'no-role' ? publicView.signedIn(c.person.id) : publicView.signedOut(cfg.mode === 'standalone' && setupNeeded(db));
    },
    /** The request's person's id and role (for the routes' own checks). */
    me: (r: Req): Readonly<Pick<Person, 'id' | 'role'>> => { const p = me(r); return Object.freeze({ id: p.id, role: p.role }); },
    /** Refuses unless this session signed in with a passkey within `minutes` (an old, stolen cookie cannot). */
    fresh: (r: Req, minutes?: number) => {
      const s = fastifyRequestOf(r).caller?.session;
      if (!s || !isFresh(s, new Date(), minutes)) throw new Refused(403, 'sign in again to do this');
    },
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
      invite: (r: Req, kind: 'self' | 'admin', personId: string) => linkAnswer(createInvite(db, cfg, { kind, personId, createdBy: me(r).id })),
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
      endSessionsOf: (personId: string) => endAllSessions(db, mustGetPerson(db, personId).id),
      resetPasskeys: (r: Req, personId: string) => resetPasskeys(db, me(r).id, personId),
    },
    people: {
      add: (i: PersonInput) => addPerson(db, i).id,
      edit: (id: string, patch: Partial<PersonInput>) => { editPerson(db, id, patch); },
      remove: (r: Req, id: string) => removePerson(db, id, me(r).id),
      setManagers: (kidId: string, ids: string[]) => setManagers(db, kidId, ids),
      setCurrency: (code: string | null) => setCurrency(db, code),
      hasPasskey: (id: string) => hasPasskey(db, mustGetPerson(db, id).id),
      /** Whether the request's person manages this kid (as a set manager, or as an admin when none is set). */
      managesKid: (r: Req, kidId: string) => managesKid(db, me(r), mustGetPerson(db, kidId)),
      setProfile: (r: Req, personId: string, i: ProfileInput) => { setProfile(db, me(r), personId, i); },
    },
    wishes: {
      add: (r: Req, personId: string, i: WishInput) => addWish(db, me(r), personId, i).id,
      edit: (r: Req, id: string, patch: Partial<WishInput>) => { editWish(db, me(r), id, patch); },
      remove: (r: Req, id: string) => removeWish(db, me(r), id),
      approve: (r: Req, id: string) => { approveWish(db, me(r), id); },
      decline: (r: Req, id: string) => declineWish(db, me(r), id),
      order: (r: Req, personId: string, ids: string[]) => orderWishes(db, me(r), personId, ids),
    },
    celebrations: {
      add: (r: Req, i: CelebrationInput) => addCelebration(db, me(r), i).id,
      edit: (r: Req, id: string, patch: Partial<CelebrationInput>) => { editCelebration(db, me(r), id, patch); },
      remove: (r: Req, id: string) => removeCelebration(db, me(r), id),
    },
  };
}

export type Data = ReturnType<typeof dataFor>;
