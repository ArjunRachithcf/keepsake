// Public: says only that the server runs, its version and mode (contracts/openapi.yaml, docs/security.md).
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Data } from '../data';
import { VERSION } from '../version';

export async function systemRoutes(app: FastifyInstance, cfg: Config, data: Data) {
  app.get('/health', { config: { auth: 'public' } }, async () => data.publicView.health(cfg, VERSION));
}
