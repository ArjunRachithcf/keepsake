// Sign-in (Philobiblos ADR 0010), standalone only: under HomersLab these answer 404 (HomersLab signs people in).
// The setup link makes the first admin; nobody becomes admin by arriving first.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { callerOf } from '../auth/hook';
import { createInvite, findInvite } from '../auth/invites';
import { credentialsOf, enrol, findPasskey, invitePersonOf, usedPasskey } from '../auth/passkeys';
import { SESSION_COOKIE, SESSION_DAYS, cookieOptions, createSession, endSession, isFresh } from '../auth/sessions';
import type { Challenges, WebAuthn } from '../auth/webauthn';
import { Refused } from '../errors';
import { mustGetPerson, setupNeeded } from '../household/people';
import { object, text } from '../validate';
import { publicView, viewFor } from '../view/view';

const limited = { auth: 'public' as const, rateLimit: { max: 20, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance, cfg: Config, db: Db, webauthn: WebAuthn, challenges: Challenges) {
  const standaloneOnly = () => {
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
  };
  // A sign-in replaces this browser's earlier session and remembers the passkey.
  const signIn = (req: FastifyRequest, reply: FastifyReply, personId: string, passkeyId: string) => {
    endSession(db, req.cookies?.[SESSION_COOKIE]);
    const { token } = createSession(db, personId, passkeyId);
    void reply.setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86_400));
    return viewFor(db, cfg, mustGetPerson(db, personId)).signedIn();
  };

  app.get('/auth/session', { config: { auth: 'public' } }, async (req) => {
    const c = callerOf(cfg, db, req);
    return c && c !== 'no-role' ? viewFor(db, cfg, c.person).signedIn() : publicView.signedOut(cfg, cfg.mode === 'standalone' && setupNeeded(db));
  });

  app.post('/auth/enrol/options', { config: limited }, async (req) => {
    standaloneOnly();
    const b = object(req.body, ['token', 'name']);
    const invite = findInvite(db, b.token);
    if (!invite) throw new Refused(401, 'this link is unknown, used or expired');
    if (invite.kind === 'setup') {
      const name = text(b, 'name', 60, { required: true })!.trim();
      const { challenge, options } = await webauthn.registrationOptions({ userId: `setup:${invite.id}`, userName: name, exclude: [] });
      return publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id, name }), options, name);
    }
    const p = invitePersonOf(db, invite);
    if (!p) throw new Refused(401, 'this link is unknown, used or expired');
    const { challenge, options } = await webauthn.registrationOptions({ userId: p.id, userName: p.name, exclude: credentialsOf(db, p.id) });
    return publicView.enrolStart(challenges.put({ challenge, kind: 'enrol', inviteId: invite.id }), options, p.name);
  });

  app.post('/auth/enrol/verify', { config: limited }, async (req, reply) => {
    standaloneOnly();
    const b = (req.body ?? {}) as { challengeId?: unknown; response?: unknown; label?: unknown };
    const pending = challenges.take(b.challengeId, 'enrol');
    if (!pending?.inviteId) throw new Refused(401, 'this sign-in step expired; start again');
    const cred = await webauthn.verifyRegistration({ response: b.response, challenge: pending.challenge });
    if (!cred) throw new Refused(401, 'the passkey could not be verified');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 40) : 'Passkey';
    const personId = enrol(db, cfg, pending.inviteId, pending.name, cred, label);
    if (personId === 'taken') throw new Refused(409, 'this passkey is already enrolled');
    if (!personId) throw new Refused(401, 'this link is unknown, used or expired');
    return signIn(req, reply, personId, cred.id);
  });

  app.post('/auth/sign-in/options', { config: limited }, async () => {
    standaloneOnly();
    const { challenge, options } = await webauthn.authenticationOptions();
    return publicView.signInStart(challenges.put({ challenge, kind: 'sign-in' }), options);
  });

  app.post('/auth/sign-in/verify', { config: limited }, async (req, reply) => {
    standaloneOnly();
    const b = (req.body ?? {}) as { challengeId?: unknown; response?: unknown };
    // One answer for every failure: which passkeys exist is nobody's business.
    const refuse = () => new Refused(401, 'that passkey did not sign you in');
    const pending = challenges.take(b.challengeId, 'sign-in');
    if (!pending) throw new Refused(401, 'this sign-in step expired; start again');
    const id = webauthn.credentialId(b.response);
    const found = id ? findPasskey(db, id) : null;
    if (!found) throw refuse();
    const ok = await webauthn.verifyAuthentication({ response: b.response, challenge: pending.challenge, credential: found.credential });
    if (!ok) throw refuse();
    usedPasskey(db, found.credential.id, ok.newCounter);
    return signIn(req, reply, found.person.id, found.credential.id);
  });

  app.post('/auth/sign-out', { config: { auth: 'public' } }, async (req, reply) => {
    endSession(db, req.cookies?.[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  // Your own link for another device: needs a sign-in of the last few minutes (an old, stolen cookie cannot).
  app.post('/me/passkeys/invite', async (req, reply) => {
    standaloneOnly();
    const s = req.caller!.session;
    if (!s || !isFresh(s)) throw new Refused(403, 'sign in again to do this');
    const me = req.caller!.person;
    const { url, expiresAt } = createInvite(db, cfg, { kind: 'self', personId: me.id, createdBy: me.id });
    return reply.code(201).send(viewFor(db, cfg, me).link(url, expiresAt));
  });
}
