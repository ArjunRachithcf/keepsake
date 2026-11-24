// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Health } from '@keepsake/contracts';
import type { Config } from './config';
import { isApi, servesPage } from './paths';
import { SECURITY_HEADERS } from './security-headers';
import { VERSION } from './version';

export interface BuiltApp { app: FastifyInstance; apiRoutes: { method: string; url: string }[] }

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]', 'req.headers["x-homerslab-name"]'] } : false,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });
  app.addHook('onSend', async (req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
    if (isApi(req.url)) void reply.header('Cache-Control', 'no-store');
  });
  const apiRoutes: BuiltApp['apiRoutes'] = [];
  app.addHook('onRoute', (r) => {
    if (!isApi(r.url)) return;
    for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push({ method: m, url: r.url });
  });
  await app.register(async (api) => {
    // Public: says only that the server runs, its version and mode (contracts/openapi.yaml, docs/security.md).
    api.get('/health', async (): Promise<Health> => ({ ok: true, version: VERSION, mode: cfg.mode }));
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
