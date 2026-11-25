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

/**
 * The sign-in rate limit's key: the socket's address, or, from the configured proxy, the last address it put in
 * X-Forwarded-For (the client it saw). Used for nothing else.
 */
export function clientKey(cfg: Pick<Config, 'rateLimitProxy'>, remoteAddress: string | undefined, headers: Headers): string {
  const socket = remoteAddress ? normaliseIp(remoteAddress) : 'unknown';
  if (!cfg.rateLimitProxy || socket !== cfg.rateLimitProxy) return socket;
  const xff = headers['x-forwarded-for'];
  const last = (typeof xff === 'string' ? xff : '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
  const ip = last ? canonicalIp(last) : null;
  return ip ? `via-proxy:${ip}` : socket;
}
