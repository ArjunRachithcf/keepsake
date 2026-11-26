// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { authHook } from './auth/hook';
import { Challenges, simpleWebAuthn, type WebAuthn } from './auth/webauthn';
import type { Config } from './config';
import type { Db } from './db/open';
import { dataFor } from './data';
import { clientKey, dropUntrustedIdentity } from './identity';
import { isApi, servesPage } from './paths';
import { authRoutes } from './routes/auth';
import { celebrationRoutes } from './routes/celebrations';
import { drawRoutes } from './routes/draws';
import { systemRoutes } from './routes/system';
import { giftRoutes } from './routes/gifts';
import { householdRoutes } from './routes/household';
import { wishRoutes } from './routes/wishes';
import { questionRoutes } from './routes/questions';
import { linkRoutes } from './routes/links';
import { guestRoutes } from './routes/guest';
import { importRoutes } from './routes/import';
import { noticeRoutes } from './routes/notices';
import { createEgress, type Egress } from './net/egress';
import { Pusher, webPushTransport, type Transport } from './push/push';
import { usableVapid } from './push/keys';
import { routerFor } from './router';
import { installSeam } from './seam';
import { SECURITY_HEADERS } from './security-headers';

export interface BuiltApp {
  app: FastifyInstance;
  apiRoutes: { method: string; url: string }[];
  /** The morning batch (jobs/morning.ts), for main.ts's scheduler and the tests. */
  morning: (now: Date) => void;
  /** The push queue (push/push.ts): `idle()` resolves once every push woken so far has gone. */
  pusher: Pusher;
}
export interface AppOptions {
  logger?: boolean;
  webauthn?: WebAuthn;
  /** Tests: what sends a push (default: Web Push through the egress client, when there is a VAPID key). */
  pushTransport?: Transport;
  /** Tests: the egress client (default: the real one, off with KEEPSAKE_EGRESS=off). */
  egress?: Egress;
}

/** Headers the logger never writes (Fastify's request serializer logs none today; this holds if that changes). */
export const REDACTED = ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]', 'req.headers["x-homerslab-name"]', 'req.headers["x-homerslab-role"]'];

export async function buildApp(cfg: Config, db: Db, opts: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ? { redact: REDACTED } : false,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });
  // First of all: X-HomersLab-* from anywhere but the trusted proxy are gone before anything reads them.
  app.addHook('onRequest', async (req) => dropUntrustedIdentity(cfg, req.socket.remoteAddress, req.headers));
  app.addHook('onSend', async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
    if (isApi(req.url)) void reply.header('Cache-Control', 'no-store');
  });
  const apiRoutes: BuiltApp['apiRoutes'] = [];
  app.addHook('onRoute', (r) => {
    if (!isApi(r.url)) return;
    for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push({ method: m, url: r.url });
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  const webauthn = opts.webauthn ?? simpleWebAuthn(cfg);
  const challenges = new Challenges();
  // The one way out (ADR 0011): pushes and shop pages both go through it.
  const egress = opts.egress ?? createEgress({ enabled: cfg.egress });
  const pusher = new Pusher(db, opts.pushTransport ?? (cfg.egress ? webPushTransport(egress, () => usableVapid(cfg), cfg.vapidSubject) : null), {
    warn: (message, fields) => app.log.warn(fields, message),
  });
  const data = dataFor(cfg, db, { pusher, egress });
  pusher.start();
  app.addHook('onClose', async () => pusher.stop());
  // The sign-in steps: 20 a minute per client (its socket address or the address a configured proxy saw; IPv6 by /64),
  // and 300 a minute for everyone together, counting only the tries a client's own limit let through: one client's
  // flood uses up its own budget and nobody else's (docs/security.md).
  const signInLimit = { max: 20, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => clientKey(cfg, req.socket.remoteAddress, req.headers) };
  const signInWindow = { start: 0, n: 0 };
  await app.register(async (api) => {
    installSeam(api);
    api.addHook('onRequest', authHook(cfg, db));
    // preHandler: after the per-client limit (an onRequest hook on each sign-in route), so refused tries do not count.
    api.addHook('preHandler', async (req, reply) => {
      if (!req.routeOptions.config.signIn) return;
      const now = Date.now();
      if (now - signInWindow.start > 60_000) { signInWindow.start = now; signInWindow.n = 0; }
      if (++signInWindow.n > 300) return reply.code(429).send({ error: 'too many tries; wait a minute' });
    });
    const router = routerFor(api, signInLimit);
    systemRoutes(router, data);
    authRoutes(router, cfg, data, webauthn, challenges);
    householdRoutes(router, cfg, data);
    wishRoutes(router, data);
    giftRoutes(router, data);
    celebrationRoutes(router, data);
    drawRoutes(router, data);
    questionRoutes(router, data);
    linkRoutes(router, data);
    guestRoutes(router, data);
    importRoutes(router, data);
    noticeRoutes(router, data);
  }, { prefix: '/api' });
  const notFound = { error: 'not found' };
  const webDir = cfg.webDir && existsSync(cfg.webDir) ? cfg.webDir : null;
  if (webDir) {
    // Routes for the build's files only (no wildcard): anything else reaches the handler below, which serves the page
    // only to a GET or HEAD outside /api and /assets/, and answers everything else with the JSON 404.
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => (webDir && servesPage(req.method, req.url) ? reply.sendFile('index.html') : reply.code(404).send(notFound)));
  return { app, apiRoutes, morning: (now) => data.notices.morning(now), pusher };
}
