// The HomersLab forwarded identity (ADR 0001, docs/security.md "For M1: identity"). The headers count only when the
// request comes straight from the configured proxy (the socket's own address, never X-Forwarded-For or req.ip); from
// anywhere else they are ignored.
import { canonicalIp, type Config } from './config';

export const PERSON_HEADER = 'x-homerslab-person';
export const NAME_HEADER = 'x-homerslab-name';
export const ROLE_HEADER = 'x-homerslab-role';
export const IDENTITY_HEADERS = [PERSON_HEADER, NAME_HEADER, ROLE_HEADER] as const;

export type Role = 'admin' | 'adult' | 'kid';
export interface Identity { externalId: string; name: string | null; role: Role | null }

type Headers = Record<string, string | string[] | undefined>;

function one(headers: Headers, name: string): string | null {
  const v = headers[name];
  if (Array.isArray(v)) return null; // a repeated header is refused, not merged
  const t = v?.trim();
  return t ? t : null;
}

/** The socket's address in canonicalIp's spelling (what KEEPSAKE_TRUSTED_PROXY is compared with). */
export const normaliseIp = (ip: string): string => canonicalIp(ip) ?? ip;

/** Whether the request's socket is the trusted proxy (homerslab mode only). */
export function fromTrustedProxy(cfg: Pick<Config, 'mode' | 'trustedProxy'>, remoteAddress: string | undefined): boolean {
  return cfg.mode === 'homerslab' && Boolean(cfg.trustedProxy) && Boolean(remoteAddress) && normaliseIp(remoteAddress!) === normaliseIp(cfg.trustedProxy!);
}

export function resolveIdentity(cfg: Pick<Config, 'mode' | 'trustedProxy'>, remoteAddress: string | undefined, headers: Headers): Identity | null {
  if (!fromTrustedProxy(cfg, remoteAddress)) return null;
  const id = one(headers, PERSON_HEADER);
  if (!id || id.length > 200) return null;
  // The role exactly as HomersLab sends it: no case folding, no trimming.
  const rawRole = headers[ROLE_HEADER];
  const role = typeof rawRole === 'string' ? rawRole : null;
  const name = one(headers, NAME_HEADER);
  return {
    externalId: id,
    name: name ? name.slice(0, 60) : null,
    role: role === 'admin' || role === 'adult' || role === 'kid' ? role : null,
  };
}

/**
 * Drops every X-HomersLab-* header that did not come from the trusted proxy, so nothing after the first hook can read
 * a forged one by mistake.
 */
export function dropUntrustedIdentity(cfg: Pick<Config, 'mode' | 'trustedProxy'>, remoteAddress: string | undefined, headers: Headers): void {
  if (fromTrustedProxy(cfg, remoteAddress)) return;
  for (const k of Object.keys(headers)) if (k.startsWith('x-homerslab-')) delete headers[k];
}

/** An IPv6 address's /64 (one household's or one host's network: they come with at least that many addresses). */
export function prefix64(ip: string): string {
  const [head = '', tail = ''] = ip.split('::') as [string, string?];
  const h = head ? head.split(':') : [];
  const tl = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - tl.length).fill('0'), ...tl] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** An address as a rate-limit key: IPv4 as it is, IPv6 by its /64. */
const keyOf = (ip: string) => (ip.includes(':') ? prefix64(ip) : ip);

/**
 * The sign-in rate limit's key: the socket's address, or, from the configured proxy, the last address it put in
 * X-Forwarded-For (the client it saw). IPv6 counts by /64, so one client cannot spread its tries over its own
 * addresses. Used for nothing else.
 */
export function clientKey(cfg: Pick<Config, 'rateLimitProxy'>, remoteAddress: string | undefined, headers: Headers): string {
  const socket = remoteAddress ? normaliseIp(remoteAddress) : 'unknown';
  if (!cfg.rateLimitProxy || socket !== cfg.rateLimitProxy) return socket === 'unknown' ? socket : keyOf(socket);
  const xff = headers['x-forwarded-for'];
  const last = (typeof xff === 'string' ? xff : '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
  const ip = last ? canonicalIp(last) : null;
  return ip ? `via-proxy:${keyOf(ip)}` : socket;
}
