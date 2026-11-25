// The one door routes have to the household's data (ADR 0003): domain operations with the database bound in, and the
// view layer for every answer. Routes never get a `Db`, so no route can query a table, reach the SQLite client or
// serialize a row; test/architecture.test.ts keeps src/routes to this module, the validators and types.
import type { FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/open';
import { callerOf } from './auth/hook';
import { createInvite, findInvite, type InviteKind } from './auth/invites';
import { credentialsOf, enrol, findPasskey, invitePersonOf, passkeysOf, removePasskey, usedPasskey } from './auth/passkeys';
import { createSession, endAllSessions, endSession } from './auth/sessions';
import type { NewCredential } from './auth/webauthn';
import { addCelebration, editCelebration, getCelebration, mustGetCelebration, removeCelebration, settlePastCelebrations, type CelebrationInput } from './celebrations/celebrations';
import { today } from './celebrations/dates';
import { Refused } from './errors';
import {
  addPerson, editPerson, hasPasskey, managesKid, mustGetPerson, removePerson, setCurrency, setManagers, setupNeeded,
  type Person, type PersonInput,
} from './household/people';
import { setProfile, type ProfileInput } from './household/profile';
import { clientKey } from './identity';
import { isId } from './validate';
import { publicView, viewFor, type ListFor } from './view/view';
import { addWish, approveWish, declineWish, editWish, orderWishes, removeWish, type WishInput } from './wishes/wishes';

export { SESSION_COOKIE, SESSION_DAYS, cookieOptions, isFresh } from './auth/sessions';
export type { Caller } from './auth/hook';
export type { Person } from './household/people';
export type { CelebrationInput } from './celebrations/celebrations';
export type { WishInput } from './wishes/wishes';
export { MAX_WISHES } from './wishes/wishes';

export function dataFor(cfg: Config, db: Db) {
  return {
    /** The view layer for one viewer. One-off celebrations whose day has passed let go of their wishes first (ADR 0007). */
    view: (me: Person) => {
      settlePastCelebrations(db, today(cfg.timezone));
      return viewFor(db, cfg, me);
    },
    publicView,
    caller: (req: FastifyRequest) => callerOf(cfg, db, req),
    /** The sign-in rate limit's and challenge store's key for a request (identity.clientKey). */
    clientKey: (req: FastifyRequest) => clientKey(cfg, req.socket.remoteAddress, req.headers),
    setupNeeded: () => setupNeeded(db),
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
      createInvite: (o: { kind: InviteKind; personId: string; createdBy: string }) => createInvite(db, cfg, o),
      credentialsOf: (personId: string) => credentialsOf(db, personId),
      enrol: (o: { inviteId: string; name?: string; newPersonId?: string }, cred: NewCredential, label: string) => enrol(db, cfg, o, cred, label),
      findPasskey: (id: string) => findPasskey(db, id),
      usedPasskey: (id: string, counter: number) => usedPasskey(db, id, counter),
      createSession: (personId: string, passkeyId: string) => createSession(db, personId, passkeyId),
      endSession: (token: string | undefined) => endSession(db, token),
      endAllSessions: (personId: string) => endAllSessions(db, personId),
      passkeysOf: (personId: string) => passkeysOf(db, personId),
      removePasskey: (personId: string, id: string) => removePasskey(db, personId, id),
    },
    people: {
      get: (id: string) => mustGetPerson(db, id),
      add: (i: PersonInput) => addPerson(db, i),
      edit: (id: string, patch: Partial<PersonInput>) => editPerson(db, id, patch),
      remove: (id: string, by: string) => removePerson(db, id, by),
      setManagers: (kidId: string, ids: string[]) => setManagers(db, kidId, ids),
      setCurrency: (code: string | null) => setCurrency(db, code),
      hasPasskey: (id: string) => hasPasskey(db, id),
      managesKid: (me: Person, kid: Person) => managesKid(db, me, kid),
      setProfile: (me: Person, personId: string, i: ProfileInput) => setProfile(db, me, personId, i),
    },
    wishes: {
      add: (me: Person, personId: string, i: WishInput) => addWish(db, me, personId, i),
      edit: (me: Person, id: string, patch: Partial<WishInput>) => editWish(db, me, id, patch),
      remove: (me: Person, id: string) => removeWish(db, me, id),
      approve: (me: Person, id: string) => approveWish(db, me, id),
      decline: (me: Person, id: string) => declineWish(db, me, id),
      order: (me: Person, personId: string, ids: string[]) => orderWishes(db, me, personId, ids),
    },
    celebrations: {
      get: (id: string) => mustGetCelebration(db, id),
      add: (me: Person, i: CelebrationInput) => addCelebration(db, me, i),
      edit: (me: Person, id: string, patch: Partial<CelebrationInput>) => editCelebration(db, me, id, patch),
      remove: (me: Person, id: string) => removeCelebration(db, me, id),
    },
  };
}

export type Data = ReturnType<typeof dataFor>;
