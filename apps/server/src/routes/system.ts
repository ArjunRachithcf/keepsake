// Public: says only that the server runs, its version and mode (contracts/openapi.yaml, docs/security.md).
import type { Data } from '../data';
import type { Router } from '../router';
import { VERSION } from '../version';

export function systemRoutes(api: Router, data: Data) {
  api.get('/health', { public: true }, () => data.publicView.health(VERSION));
}
