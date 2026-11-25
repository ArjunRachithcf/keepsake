// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged. Security settings live here only, never in an editable database row (spec §10).
import { join, resolve } from 'node:path';

export type Mode = 'homerslab' | 'standalone';

export interface Config {
  mode: Mode;
  dataDir: string;
  dbFile: string;
  host: string;
  port: number;
  /** The household's time zone (IANA): what "today" is for celebrations. */
  timezone: string;
  webDir: string | null;
  /** homerslab: the only address whose X-HomersLab-* headers are trusted (compared with the socket's address). */
  trustedProxy: string | null;
  /** The address people open (scheme, host, port): WebAuthn's origin, and the Origin every change must carry. */
  origin: string;
  rpId: string;
}

/**
 * What HomersLab's edge must promise before Keepsake trusts its identity headers (HomersLab #236): it deletes every
 * X-HomersLab-* header a client sends and sets X-HomersLab-Person, -Name and -Role itself. HomersLab sets
 * KEEPSAKE_EDGE_IDENTITY to this value once its edge does that; until then homerslab mode does not start.
 */
export const EDGE_IDENTITY = 'homerslab-v1';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.KEEPSAKE_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`KEEPSAKE_MODE must be homerslab or standalone, not ${mode}`);
  const port = Number(env.KEEPSAKE_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`KEEPSAKE_PORT must be a port number, not ${env.KEEPSAKE_PORT}`);
  // Under HomersLab the address and the edge are HomersLab's to give; a guess would make every Origin check wrong, and
  // trusting headers from an edge that does not strip them would let anyone be anyone.
  if (mode === 'homerslab' && !env.KEEPSAKE_ORIGIN) throw new Error('KEEPSAKE_ORIGIN must be set in homerslab mode');
  if (mode === 'homerslab' && env.KEEPSAKE_EDGE_IDENTITY !== EDGE_IDENTITY) {
    throw new Error(`homerslab mode needs an edge that strips and sets the X-HomersLab-* headers (HomersLab #236): KEEPSAKE_EDGE_IDENTITY=${EDGE_IDENTITY}`);
  }
  if (mode === 'homerslab' && !env.KEEPSAKE_TRUSTED_PROXY) throw new Error('KEEPSAKE_TRUSTED_PROXY must be set in homerslab mode');
  const timezone = env.KEEPSAKE_TZ ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error(`KEEPSAKE_TZ must be an IANA time zone, not ${timezone}`); }
  const dataDir = resolve(env.KEEPSAKE_DATA_DIR ?? './data');
  const origin = parseOrigin(env.KEEPSAKE_ORIGIN ?? `http://localhost:${port}`);
  return {
    mode,
    dataDir,
    dbFile: env.KEEPSAKE_DB_FILE ?? join(dataDir, 'keepsake.sqlite'),
    // Standalone binds to localhost unless told otherwise (docs/security.md); the container sets KEEPSAKE_HOST=0.0.0.0
    // and compose publishes the port on 127.0.0.1 only.
    host: env.KEEPSAKE_HOST ?? '127.0.0.1',
    port,
    timezone,
    webDir: env.KEEPSAKE_WEB_DIR ?? null,
    trustedProxy: mode === 'homerslab' ? env.KEEPSAKE_TRUSTED_PROXY! : null,
    origin: origin.origin,
    rpId: origin.hostname,
  };
}

function parseOrigin(v: string): URL {
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`KEEPSAKE_ORIGIN must be scheme://host[:port], not ${v}`); }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error(`KEEPSAKE_ORIGIN must be scheme://host[:port], not ${v}`);
  // WebAuthn and Secure cookies need a secure context: https, or http only on localhost.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
    throw new Error(`KEEPSAKE_ORIGIN must be https (or http://localhost), not ${v}`);
  }
  return u;
}
