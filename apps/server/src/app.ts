// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { authHook } from './auth/hook';
import { Challenges, simpleWebAuthn, type WebAuthn } from './auth/webauthn';
import type { Config } from './config';
import type { Db } from './db/open';
import { Refused } from './errors';
import { dropUntrustedIdentity } from './identity';
import { isApi, servesPage } from './paths';
import { authRoutes } from './routes/auth';
import { celebrationRoutes } from './routes/celebrations';
import { householdRoutes } from './routes/household';
import { wishRoutes } from './routes/wishes';
import { SECURITY_HEADERS } from './security-headers';
import { VERSION } from './version';
import { isViewed, publicView } from './view/view';

export interface BuiltApp { app: FastifyInstance; apiRoutes: { method: string; url: string }[] }
export interface AppOptions { logger?: boolean; webauthn?: WebAuthn }

/** Headers the logger never writes (Fastify's request serializer logs none today; this holds if that changes). */
export const REDACTED = ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]', 'req.headers["x-homerslab-name"]', 'req.headers["x-homerslab-role"]'];

/** ADR 0003's seam: an /api answer below 400 that the view layer did not build is never sent (a 500 instead). */
export async function viewGuard(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (reply.statusCode < 400 && !isViewed(payload)) {
    req.log.error({ url: req.routeOptions.url }, 'an answer that did not come from the view layer');
    throw new Error('unviewed answer');
  }
  return payload;
}

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
  await app.register(async (api) => {
    api.addHook('onRequest', authHook(cfg, db));
    api.addHook('preSerialization', viewGuard);
    api.setErrorHandler((err, req, reply) => {
      if (err instanceof Refused) return reply.code(err.status).send({ error: err.message });
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 429) return reply.code(429).send({ error: 'too many tries; wait a minute' });
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 415 ? 'send JSON' : 'the request is not valid' });
      req.log.error(err);
      return reply.code(500).send({ error: 'something went wrong' });
    });
    // Public: says only that the server runs, its version and mode (contracts/openapi.yaml, docs/security.md).
    api.get('/health', { config: { auth: 'public' } }, async () => publicView.health(cfg, VERSION));
    await authRoutes(api, cfg, db, webauthn, challenges);
    await householdRoutes(api, cfg, db);
    await wishRoutes(api, cfg, db);
    await celebrationRoutes(api, cfg, db);
  }, { prefix: '/api' });
  const notFound = { error: 'not found' };
  const webDir = cfg.webDir && existsSync(cfg.webDir) ? cfg.webDir : null;
  if (webDir) {
    // Routes for the build's files only (no wildcard): anything else reaches the handler below, which serves the page
    // only to a GET or HEAD outside /api and /assets/, and answers everything else with the JSON 404.
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => (webDir && servesPage(req.method, req.url) ? reply.sendFile('index.html') : reply.code(404).send(notFound)));
  return { app, apiRoutes };
}
