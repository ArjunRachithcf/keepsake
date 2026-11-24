// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged.
import { resolve } from 'node:path';

export type Mode = 'homerslab' | 'standalone';

export interface Config {
  mode: Mode;
  dataDir: string;
  host: string;
  port: number;
  timezone: string;
  webDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.KEEPSAKE_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`KEEPSAKE_MODE must be homerslab or standalone, not ${mode}`);
  const port = Number(env.KEEPSAKE_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`KEEPSAKE_PORT must be a port number, not ${env.KEEPSAKE_PORT}`);
  return {
    mode,
    dataDir: resolve(env.KEEPSAKE_DATA_DIR ?? './data'),
    // Standalone binds to localhost unless told otherwise (docs/security.md); the container sets KEEPSAKE_HOST=0.0.0.0
    // and compose publishes the port on 127.0.0.1 only.
    host: env.KEEPSAKE_HOST ?? '127.0.0.1',
    port,
    timezone: env.KEEPSAKE_TZ ?? 'Europe/Zurich',
    webDir: env.KEEPSAKE_WEB_DIR ?? null,
  };
}
