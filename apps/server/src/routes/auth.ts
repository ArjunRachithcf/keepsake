// Sign-in (Philobiblos ADR 0010), standalone only: under HomersLab these answer 404 (HomersLab signs people in).
// The setup link makes the first admin; nobody becomes admin by arriving first. Your passkeys and sessions are yours
// to list, remove and end; a kid's parent (or an admin) can end someone's sessions when a device is lost; an admin,
// just signed in, can reset the passkeys of someone who lost them all.
import { ulid } from 'ulid';
import type { Challenges, WebAuthn } from '../auth/webauthn';
import type { Config } from '../config';
import { RESET_FRESH_MINUTES, type Data } from '../data';
import { Refused } from '../errors';
import type { Req, Res, Router } from '../router';
import { object, text } from '../validate';

export function authRoutes(api: Router, cfg: Config, data: Data, webauthn: WebAuthn, challenges: Challenges) {
  const standaloneOnly = () => {
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
  };
  // A sign-in replaces this browser's earlier session and remembers the passkey.
  const signIn = (r: Req, res: Res, personId: string, passkeyId: string) => {
    res.startSession(data.auth.signIn(r, personId, passkeyId));
    return data.publicView.signedIn(personId);
  };

  api.get('/auth/session', { public: true }, (r) => data.session(r));

  api.post('/auth/enrol/options', { public: true, signIn: true }, async (r) => {
    standaloneOnly();
    const b = object(r.body, ['token', 'name']);
    const invite = data.auth.findInvite(b.token);
    if (!invite) throw new Refused(401, 'this link is unknown, used or expired');
    if (invite.kind === 'setup') {
      const name = text(b, 'name', 60, { required: true })!.trim();
      // The first admin's id is chosen now, so the authenticator's user handle is the person's id.
      const newPersonId = ulid();
      const { challenge, options } = await webauthn.registrationOptions({ userId: newPersonId, userName: name, exclude: [] });
      return data.publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id, name, newPersonId }, data.clientKey(r)), options);
    }
    const p = data.auth.invitee(b.token);
    if (!p) throw new Refused(401, 'this link is unknown, used or expired');
    const { challenge, options } = await webauthn.registrationOptions({ userId: p.id, userName: p.name, exclude: data.auth.credentialsOf(p.id) });
    return data.publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id }, data.clientKey(r)), options);
  });

  api.post('/auth/enrol/verify', { public: true, signIn: true }, async (r, res) => {
    standaloneOnly();
    const b = (r.body ?? {}) as { challengeId?: unknown; response?: unknown; label?: unknown };
    const pending = challenges.take(b.challengeId, 'enrol');
    if (!pending?.inviteId) throw new Refused(401, 'this sign-in step expired; start again');
    const cred = await webauthn.verifyRegistration({ response: b.response, challenge: pending.challenge });
    if (!cred) throw new Refused(401, 'the passkey could not be verified');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 40) : 'Passkey';
    const personId = data.auth.enrol({ inviteId: pending.inviteId, name: pending.name, newPersonId: pending.newPersonId }, cred, label);
    if (personId === 'taken') throw new Refused(409, 'this passkey is already enrolled');
    if (!personId) throw new Refused(401, 'this link is unknown, used or expired');
    return signIn(r, res, personId, cred.id);
  });

  api.post('/auth/sign-in/options', { public: true, signIn: true }, async (r) => {
    standaloneOnly();
    const { challenge, options } = await webauthn.authenticationOptions();
    return data.publicView.signInStart(challenges.put({ challenge, kind: 'sign-in' }, data.clientKey(r)), options);
  });

  api.post('/auth/sign-in/verify', { public: true, signIn: true }, async (r, res) => {
    standaloneOnly();
    const b = (r.body ?? {}) as { challengeId?: unknown; response?: unknown };
    // One answer for every failure: which passkeys exist is nobody's business.
    const refuse = () => new Refused(401, 'that passkey did not sign you in');
    const pending = challenges.take(b.challengeId, 'sign-in');
    if (!pending) throw new Refused(401, 'this sign-in step expired; start again');
    const id = webauthn.credentialId(b.response);
    const found = id ? data.auth.findPasskey(id) : null;
    if (!found) throw refuse();
    const ok = await webauthn.verifyAuthentication({ response: b.response, challenge: pending.challenge, credential: found.credential });
    if (!ok) throw refuse();
    data.auth.usedPasskey(found.credential.id, ok.newCounter);
    return signIn(r, res, found.person.id, found.credential.id);
  });

  api.post('/auth/sign-out', { public: true }, (r, res) => {
    data.auth.endThisSession(r);
    res.endSession();
  });

  // Your own link for another device: needs a sign-in of the last few minutes (an old, stolen cookie cannot).
  api.post('/me/passkeys/invite', (r, res) => {
    standaloneOnly();
    data.fresh(r);
    res.created();
    return data.auth.invite(r, 'self', data.me(r).id);
  });

  api.get('/me/passkeys', (r) => {
    standaloneOnly();
    return data.view(r).passkeys();
  });

  // Removing a passkey ends the sessions it signed in (they cascade); your last one stays.
  api.delete('/me/passkeys/:passkeyId', (r) => {
    standaloneOnly();
    data.auth.removeMyPasskey(r, r.params.passkeyId);
  });

  // "Sign out everywhere": every session of yours ends, this one too.
  api.post('/me/sessions/end', (r, res) => {
    standaloneOnly();
    data.auth.endMySessions(r);
    res.endSession();
  });

  // A lost device: a kid's parent, or an admin, ends someone else's sessions (their passkeys stay; a device lock still
  // guards them, and the person removes one on another device).
  api.post('/people/:personId/sessions/end', (r) => {
    standaloneOnly();
    if (data.me(r).role !== 'admin' && !data.people.managesKid(r, r.params.personId)) throw new Refused(403, 'a kid\'s parent or an admin only');
    data.auth.endSessionsOf(r.params.personId);
  });

  // Every device lost: an admin who signed in with a passkey in the last 5 minutes removes someone's passkeys (their
  // sessions end with them), then sends the usual invite. Not an admin's: an admin recovers with `keepsake recover`.
  // Recorded in the audit table.
  api.post('/people/:personId/passkeys/reset', (r) => {
    standaloneOnly();
    if (data.me(r).role !== 'admin') throw new Refused(403, 'admins only');
    data.fresh(r, RESET_FRESH_MINUTES);
    data.auth.resetPasskeys(r, r.params.personId);
  });
}
