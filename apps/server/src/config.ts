// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged. Security settings live here only, never in an editable database row (spec §10).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';

export type Mode = 'homerslab' | 'standalone';

export interface Config {
  mode: Mode;
  dataDir: string;
  /**
   * KEEPSAKE_KEYS_DIR (default ./keys): standalone's key files and its one-time admin links (setup, `keepsake recover`),
   * kept out of the data folder and so out of its backups (Gate routes L2).
   */
  keysDir: string;
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
  /**
   * A previous key (KEEPSAKE_SEALING_KEY_PREVIOUS or _PREVIOUS_FILE), only to open rows it sealed: after a rotation, a
   * new draw seals with the new key and `keepsake rotate-key` reseals the old rows.
   */
  sealingKeyPrevious: SealingKeySource | null;
  /**
   * Web Push's VAPID key (ADR 0010; never the database, kept as the sealing key is): KEEPSAKE_VAPID_KEY (base64url, the
   * 32-byte P-256 private scalar) or KEEPSAKE_VAPID_KEY_FILE; standalone makes KEEPSAKE_KEYS_DIR/vapid.key once. null:
   * no push (homerslab mode without the secret). Hidden from logs like the sealing key.
   */
  vapidKey: SealingKeySource | null;
  /**
   * Who runs this Keepsake, for the push services (VAPID `sub`): KEEPSAKE_VAPID_SUBJECT (mailto: or https:), else a
   * neutral `mailto:` that names no household (PR #12 review, L2): the origin would go to every push service with every push.
   */
  vapidSubject: string;
  /** false: nothing leaves Keepsake (KEEPSAKE_EGRESS=off): no push, no page read from a shop link (ADR 0011). */
  egress: boolean;
  /**
   * The shops whose pages "Add from a link" may read (ADR 0011): exact host names from KEEPSAKE_SHOP_HOSTS (comma
   * separated), https only. Empty (the default): the feature is off and no shop page is ever fetched.
   */
  shopHosts: readonly string[];
}

export type SealingKeySource = { value: string } | { file: string; create: boolean };

/**
 * What HomersLab's edge must promise before Keepsake trusts its identity headers (HomersLab #236): it deletes every
 * X-HomersLab-* header a client sends and sets X-HomersLab-Person, -Name and -Role itself. HomersLab sets
 * KEEPSAKE_EDGE_IDENTITY to this value once its edge does that; until then homerslab mode does not start.
 */
export const EDGE_IDENTITY = 'homerslab-v1';

/** The VAPID subject when none is set: a reserved domain (RFC 2606), so it names no household (ADR 0010). */
export const DEFAULT_VAPID_SUBJECT = 'mailto:keepsake@example.org';

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
  const sealingKeyPrevious = previousKeySource(env, dataDir);
  const vapidKey = keySource(env, mode, dataDir, VAPID);
  const egress = (env.KEEPSAKE_EGRESS ?? 'on') !== 'off';
  if (env.KEEPSAKE_EGRESS && env.KEEPSAKE_EGRESS !== 'on' && env.KEEPSAKE_EGRESS !== 'off') throw new Error(`KEEPSAKE_EGRESS must be on or off, not ${env.KEEPSAKE_EGRESS}`);
  // Only a subject someone set is checked: the default is fixed and fits every origin (http on loopback included).
  const vapidSubject = env.KEEPSAKE_VAPID_SUBJECT ?? DEFAULT_VAPID_SUBJECT;
  if (env.KEEPSAKE_VAPID_SUBJECT !== undefined && !/^(?:mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+|https:\/\/[^\s/]+(?:\/\S*)?)$/.test(vapidSubject)) {
    throw new Error(`KEEPSAKE_VAPID_SUBJECT must be mailto:… or https://…, not ${vapidSubject}`);
  }
  return {
    mode,
    dataDir,
    keysDir: resolve(env.KEEPSAKE_KEYS_DIR ?? './keys'),
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
    sealingKeyPrevious,
    vapidKey,
    vapidSubject,
    egress,
    shopHosts: Object.freeze(shopHostsOf(env.KEEPSAKE_SHOP_HOSTS)),
  };
}

/** A host name as a shop's address names it: lower case letters, digits, dots and hyphens, two labels at least; no IP, no port. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
function shopHostsOf(v: string | undefined): string[] {
  if (!v || !v.trim()) return [];
  const hosts = v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) if (!HOST.test(h) || isIP(h)) throw new Error(`KEEPSAKE_SHOP_HOSTS: host names only (no scheme, port, path or IP address), not ${h}`);
  if (hosts.length > 100) throw new Error('KEEPSAKE_SHOP_HOSTS: at most 100 shops');
  return [...new Set(hosts)];
}

/** A path with every existing part resolved through symlinks (what is missing kept as written). */
function real(p: string): string {
  let q = resolve(p);
  const rest: string[] = [];
  while (!existsSync(q) && dirname(q) !== q) { rest.unshift(basename(q)); q = dirname(q); }
  return join(realpathSync(q), ...rest);
}
/**
 * Whether `file` is inside (or is) `dir`: by real paths, and by device and inode, so neither a symlink nor a bind
 * mount of the data folder under another name gets a key file into it.
 */
export function isInside(dir: string, file: string): boolean {
  const r = relative(real(dir), real(file));
  if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) return true;
  if (!existsSync(dir)) return false;
  const d = statSync(dir);
  for (let q = real(file); ; q = dirname(q)) {
    if (existsSync(q)) { const s = statSync(q); if (s.dev === d.dev && s.ino === d.ino) return true; }
    if (dirname(q) === q) return false;
  }
}
const hidden = <T extends object>(o: T): T => Object.defineProperty(o, 'toJSON', { value: () => ({ value: '[hidden]' }), enumerable: false });
const NOT_IN_DATA = 'the sealing key must not be in KEEPSAKE_DATA_DIR (a backup of the data would carry it): set KEEPSAKE_KEYS_DIR or KEEPSAKE_SEALING_KEY_FILE elsewhere';

/** Which key: the draws' sealing key, or Web Push's VAPID key (the same rules, ADR 0010). */
interface KeyNames { value: string; file: string; standalone: string; notInData: string }
const SEALING: KeyNames = { value: 'KEEPSAKE_SEALING_KEY', file: 'KEEPSAKE_SEALING_KEY_FILE', standalone: 'sealing.key', notInData: NOT_IN_DATA };
const VAPID: KeyNames = {
  value: 'KEEPSAKE_VAPID_KEY', file: 'KEEPSAKE_VAPID_KEY_FILE', standalone: 'vapid.key',
  notInData: 'the VAPID key must not be in KEEPSAKE_DATA_DIR (a backup of the data would carry it): set KEEPSAKE_KEYS_DIR or KEEPSAKE_VAPID_KEY_FILE elsewhere',
};

function previousKeySource(env: NodeJS.ProcessEnv, dataDir: string): SealingKeySource | null {
  if (env.KEEPSAKE_SEALING_KEY_PREVIOUS) return Object.freeze(hidden({ value: env.KEEPSAKE_SEALING_KEY_PREVIOUS }));
  if (!env.KEEPSAKE_SEALING_KEY_PREVIOUS_FILE) return null;
  const file = resolve(env.KEEPSAKE_SEALING_KEY_PREVIOUS_FILE);
  if (isInside(dataDir, file)) throw new Error(NOT_IN_DATA);
  return Object.freeze({ file, create: false });
}

/** A key's source; refuses a key file inside the data folder (a backup of it would carry the key). */
function keySource(env: NodeJS.ProcessEnv, mode: Mode, dataDir: string, k: KeyNames = SEALING): SealingKeySource | null {
  const value = env[k.value];
  if (value) return Object.freeze(hidden({ value }));
  const named = env[k.file];
  const file = named ? resolve(named) : mode === 'standalone' ? join(resolve(env.KEEPSAKE_KEYS_DIR ?? './keys'), k.standalone) : null;
  if (!file) return null;
  if (isInside(dataDir, file)) throw new Error(k.notInData);
  return Object.freeze({ file, create: !named });
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

/** Loopback host names an http origin may have (a secure context in browsers). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseOrigin(v: string): URL {
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`KEEPSAKE_ORIGIN must be scheme://host[:port], not ${v}`); }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error(`KEEPSAKE_ORIGIN must be scheme://host[:port], not ${v}`);
  // WebAuthn and Secure cookies need a secure context: https, or http only on localhost.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error(`KEEPSAKE_ORIGIN must be https (or http://localhost), not ${v}`);
  }
  return u;
}
