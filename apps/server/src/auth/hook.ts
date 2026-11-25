// Deny by default (ADR 0006). Every /api route needs a person unless its config says `auth: 'public'` (/health and the
// sign-in steps). The person comes from the HomersLab headers sent by the trusted edge (homerslab mode) or from a
// passkey session cookie (standalone), never both: a cookie means nothing under HomersLab, a header nothing
// standalone. Every change (anything but GET/HEAD/OPTIONS) must carry Keepsake's own Origin, in both modes, public
// routes included. Kids sign in too; what they may do is decided by the domain modules.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { getPerson, syncHomersLabPerson, type Person } from '../household/people';
import { resolveIdentity } from '../identity';
import { SESSION_COOKIE, liveSession, type Session } from './sessions';

export type AuthMode = 'public' | 'person';

export interface Caller { person: Person; via: 'homerslab' | 'session'; session?: Session }

declare module 'fastify' {
  interface FastifyContextConfig { auth?: AuthMode; signIn?: boolean }
  interface FastifyRequest { caller?: Caller }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The person behind a request, if any (no Origin check, no refusal): used by the hook and by GET /auth/session. */
export function callerOf(cfg: Config, db: Db, req: FastifyRequest): Caller | 'no-role' | null {
  if (cfg.mode === 'homerslab') {
    const identity = resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
    if (!identity) return null;
    if (!identity.role) return 'no-role';
    return { person: syncHomersLabPerson(db, { ...identity, role: identity.role }), via: 'homerslab' };
  }
  const s = liveSession(db, req.cookies?.[SESSION_COOKIE]);
  const p = s ? getPerson(db, s.personId) : undefined;
  return s && p ? { person: p, via: 'session', session: s } : null;
}

export function authHook(cfg: Config, db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!SAFE.has(req.method) && req.headers.origin !== cfg.origin) {
      return reply.code(403).send({ error: 'request from another origin refused' });
    }
    if ((req.routeOptions.config.auth ?? 'person') === 'public') return;
    const caller = callerOf(cfg, db, req);
    // Without a valid role Keepsake cannot tell an adult from a kid: refused, not guessed.
    if (caller === 'no-role') return reply.code(403).send({ error: 'not allowed' });
    if (!caller) return reply.code(401).send({ error: 'sign in required' });
    req.caller = caller;
  };
}
