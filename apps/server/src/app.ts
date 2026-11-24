// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Health } from '@keepsake/contracts';
import type { Config } from './config';
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
    if (req.url.startsWith('/api/')) void reply.header('Cache-Control', 'no-store');
  });
  const apiRoutes: BuiltApp['apiRoutes'] = [];
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith('/api/')) return;
    for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push({ method: m, url: r.url });
  });
  await app.register(async (api) => {
    // Public: says only that the server runs, its version and mode (contracts/openapi.yaml, docs/security.md).
    api.get('/health', async (): Promise<Health> => ({ ok: true, version: VERSION, mode: cfg.mode }));
  }, { prefix: '/api' });
  if (cfg.webDir && existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  }
  return { app, apiRoutes };
}
