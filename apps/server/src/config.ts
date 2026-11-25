// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged. Security settings live here only, never in an editable database row (spec §10).
import { isIP } from 'node:net';
import { join, relative, resolve, isAbsolute } from 'node:path';

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
  /**
   * The proxy in front of Keepsake (homerslab: the edge; standalone: optional, e.g. an https reverse proxy), whose
   * X-Forwarded-For is used for one thing only: the sign-in rate limit's key, so clients behind it are counted apart.
   * Never for identity in standalone mode.
   */
  rateLimitProxy: string | null;
  /** The address people open (scheme, host, port): WebAuthn's origin, and the Origin every change must carry. */
  origin: string;
  rpId: string;
  /**
   * Where the key that seals the draws comes from (ADR 0004; never the database): KEEPSAKE_SEALING_KEY (base64, 32
   * bytes) or KEEPSAKE_SEALING_KEY_FILE; standalone falls back to a file it makes once in KEEPSAKE_KEYS_DIR (default
   * ./keys; /keys in the image), its own folder, never the data folder a backup copies. null: no key, so no draw is
   * made or opened (homerslab mode without the secret). The value never reaches a log (`toJSON` hides it).
   */
  sealingKey: SealingKeySource | null;
}

export type SealingKeySource = { value: string } | { file: string; create: boolean };

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
  const proxy = env.KEEPSAKE_TRUSTED_PROXY ? canonicalIp(env.KEEPSAKE_TRUSTED_PROXY) : null;
  if (env.KEEPSAKE_TRUSTED_PROXY && !proxy) {
    throw new Error(`KEEPSAKE_TRUSTED_PROXY must be one IP address (no host name, range or port), not ${env.KEEPSAKE_TRUSTED_PROXY}`);
  }
  const timezone = env.KEEPSAKE_TZ ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error(`KEEPSAKE_TZ must be an IANA time zone, not ${timezone}`); }
  const dataDir = resolve(env.KEEPSAKE_DATA_DIR ?? './data');
  const origin = parseOrigin(env.KEEPSAKE_ORIGIN ?? `http://localhost:${port}`);
  const sealingKey = keySource(env, mode, dataDir);
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
    trustedProxy: mode === 'homerslab' ? proxy : null,
    rateLimitProxy: proxy,
    origin: origin.origin,
    rpId: origin.hostname,
    sealingKey,
  };
}

/** The sealing key's source; refuses a key file inside the data folder (a backup of it would carry the key). */
function keySource(env: NodeJS.ProcessEnv, mode: Mode, dataDir: string): SealingKeySource | null {
  const inside = (f: string) => { const r = relative(dataDir, resolve(f)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  const hidden = <T extends object>(o: T, shown: object): T => Object.defineProperty(o, 'toJSON', { value: () => shown, enumerable: false });
  if (env.KEEPSAKE_SEALING_KEY) return Object.freeze(hidden({ value: env.KEEPSAKE_SEALING_KEY }, { value: '[hidden]' }));
  const file = env.KEEPSAKE_SEALING_KEY_FILE ? resolve(env.KEEPSAKE_SEALING_KEY_FILE)
    : mode === 'standalone' ? join(resolve(env.KEEPSAKE_KEYS_DIR ?? './keys'), 'sealing.key') : null;
  if (!file) return null;
  if (inside(file)) throw new Error('the sealing key must not be in KEEPSAKE_DATA_DIR (a backup of the data would carry it): set KEEPSAKE_KEYS_DIR or KEEPSAKE_SEALING_KEY_FILE elsewhere');
  return Object.freeze({ file, create: !env.KEEPSAKE_SEALING_KEY_FILE });
}

/** One spelling per address: IPv4-mapped IPv6 as IPv4, IPv6 compressed and lower case; null if it is not an IP. */
export function canonicalIp(v: string): string | null {
  let ip = v.trim();
  if (/^::ffff:/i.test(ip) && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return /^::ffff:\d/.test(host) ? host.slice(7) : host.replace(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/, (_m, a: string, b: string) => {
    const n = (parseInt(a, 16) << 16) + parseInt(b, 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  });
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
