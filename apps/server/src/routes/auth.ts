// Sign-in (Philobiblos ADR 0010), standalone only: under HomersLab these answer 404 (HomersLab signs people in).
// The setup link makes the first admin; nobody becomes admin by arriving first. Your passkeys and sessions are yours
// to list, remove and end; a kid's parent (or an admin) can end someone's sessions when a device is lost.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { Challenges, WebAuthn } from '../auth/webauthn';
import type { Config } from '../config';
import { SESSION_COOKIE, SESSION_DAYS, cookieOptions, isFresh, type Data } from '../data';
import { Refused } from '../errors';
import { object, text } from '../validate';

export async function authRoutes(app: FastifyInstance, cfg: Config, data: Data, webauthn: WebAuthn, challenges: Challenges, limited: object) {
  const standaloneOnly = () => {
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
  };
  const key = (req: FastifyRequest) => data.clientKey(req);
  // A sign-in replaces this browser's earlier session and remembers the passkey.
  const signIn = (req: FastifyRequest, reply: FastifyReply, personId: string, passkeyId: string) => {
    data.auth.endSession(req.cookies?.[SESSION_COOKIE]);
    const { token } = data.auth.createSession(personId, passkeyId);
    void reply.setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86_400));
    return data.view(data.people.get(personId)).signedIn();
  };
  const fresh = (req: FastifyRequest) => {
    const s = req.caller!.session;
    if (!s || !isFresh(s)) throw new Refused(403, 'sign in again to do this');
  };

  app.get('/auth/session', { config: { auth: 'public' } }, async (req) => {
    const c = data.caller(req);
    return c && c !== 'no-role' ? data.view(c.person).signedIn() : data.publicView.signedOut(cfg, cfg.mode === 'standalone' && data.setupNeeded());
  });

  app.post('/auth/enrol/options', { config: limited }, async (req) => {
    standaloneOnly();
    const b = object(req.body, ['token', 'name']);
    const invite = data.auth.findInvite(b.token);
    if (!invite) throw new Refused(401, 'this link is unknown, used or expired');
    if (invite.kind === 'setup') {
      const name = text(b, 'name', 60, { required: true })!.trim();
      // The first admin's id is chosen now, so the authenticator's user handle is the person's id.
      const newPersonId = ulid();
      const { challenge, options } = await webauthn.registrationOptions({ userId: newPersonId, userName: name, exclude: [] });
      return data.publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id, name, newPersonId }, key(req)), options, name);
    }
    const p = data.auth.invitee(b.token);
    if (!p) throw new Refused(401, 'this link is unknown, used or expired');
    const { challenge, options } = await webauthn.registrationOptions({ userId: p.id, userName: p.name, exclude: data.auth.credentialsOf(p.id) });
    return data.publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id }, key(req)), options, p.name);
  });

  app.post('/auth/enrol/verify', { config: limited }, async (req, reply) => {
    standaloneOnly();
    const b = (req.body ?? {}) as { challengeId?: unknown; response?: unknown; label?: unknown };
    const pending = challenges.take(b.challengeId, 'enrol');
    if (!pending?.inviteId) throw new Refused(401, 'this sign-in step expired; start again');
    const cred = await webauthn.verifyRegistration({ response: b.response, challenge: pending.challenge });
    if (!cred) throw new Refused(401, 'the passkey could not be verified');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 40) : 'Passkey';
    const personId = data.auth.enrol({ inviteId: pending.inviteId, name: pending.name, newPersonId: pending.newPersonId }, cred, label);
    if (personId === 'taken') throw new Refused(409, 'this passkey is already enrolled');
    if (!personId) throw new Refused(401, 'this link is unknown, used or expired');
    return signIn(req, reply, personId, cred.id);
  });

  app.post('/auth/sign-in/options', { config: limited }, async (req) => {
    standaloneOnly();
    const { challenge, options } = await webauthn.authenticationOptions();
    return data.publicView.signInStart(challenges.put({ challenge, kind: 'sign-in' }, key(req)), options);
  });

  app.post('/auth/sign-in/verify', { config: limited }, async (req, reply) => {
    standaloneOnly();
    const b = (req.body ?? {}) as { challengeId?: unknown; response?: unknown };
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
    return signIn(req, reply, found.person.id, found.credential.id);
  });

  app.post('/auth/sign-out', { config: { auth: 'public' } }, async (req, reply) => {
    data.auth.endSession(req.cookies?.[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  // Your own link for another device: needs a sign-in of the last few minutes (an old, stolen cookie cannot).
  app.post('/me/passkeys/invite', async (req, reply) => {
    standaloneOnly();
    fresh(req);
    const me = req.caller!.person;
    const { url, expiresAt } = data.auth.createInvite({ kind: 'self', personId: me.id, createdBy: me.id });
    return reply.code(201).send(data.view(me).link(url, expiresAt));
  });

  app.get('/me/passkeys', async (req) => {
    standaloneOnly();
    const me = req.caller!.person;
    return data.view(me).passkeys(data.auth.passkeysOf(me.id));
  });

  // Removing a passkey ends the sessions it signed in (they cascade); your last one stays.
  app.delete<{ Params: { passkeyId: string } }>('/me/passkeys/:passkeyId', async (req, reply) => {
    standaloneOnly();
    data.auth.removePasskey(req.caller!.person.id, req.params.passkeyId);
    return reply.code(204).send();
  });

  // "Sign out everywhere": every session of yours ends, this one too.
  app.post('/me/sessions/end', async (req, reply) => {
    standaloneOnly();
    data.auth.endAllSessions(req.caller!.person.id);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  // A lost device: a kid's parent, or an admin, ends someone else's sessions (their passkeys stay; a device lock still
  // guards them, and the person removes one on another device).
  app.post<{ Params: { personId: string } }>('/people/:personId/sessions/end', async (req, reply) => {
    standaloneOnly();
    const me = req.caller!.person;
    const p = data.people.get(req.params.personId);
    if (me.role !== 'admin' && !data.people.managesKid(me, p)) throw new Refused(403, 'a kid\'s parent or an admin only');
    data.auth.endAllSessions(p.id);
    return reply.code(204).send();
  });
}
