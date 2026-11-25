// The one HTTP client of the whole server (ADR 0011, Philobiblos' egress, its ADR 0009). Nothing else in apps/server
// opens a connection (test/architecture.test.ts keeps it so): every outgoing request names a host on the allowlist, and
// the answer is held to a size, a time and a content type before anyone reads it.
//
// - Only allowlisted hosts, by name (the shops in KEEPSAKE_SHOP_HOSTS, the Web Push services); https on 443 only.
// - The name is resolved here and the connection goes to the address that was checked (no second lookup a DNS
//   rebinding could change); every address the name resolves to must be public, so a hostile DNS answer cannot point
//   Keepsake at the router, the HomersLab edge, the host or a container next to it.
// - Redirects: at most 3, each to a host on the same allowlist (checked and resolved again), https only.
// - No compression (no decompression bomb), a byte limit counted as the body arrives, one deadline for the whole
//   exchange including the lookups and redirects, and the content type checked against what the caller expects.
// - No cookies, no credentials, no Referer; a User-Agent that says what Keepsake is and nothing about the household.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { VERSION } from '../version';

/** A host that may be reached: an exact name, or (push services) a pattern anchored on both ends. */
export type Host = string | RegExp;
export interface Rules { name: string; hosts: readonly Host[] }

/** What the caller expects back: a shop's page (HTML), or a push service's answer (its body is not read beyond a little). */
export type Want = 'html' | 'push';
export const LIMITS: Record<Want, number> = { html: 1 << 20, push: 4 << 10 };
export const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const TYPES: Record<Want, RegExp> = { html: /^(?:text\/html|application\/xhtml\+xml)$/, push: /^.*$/ };
export const USER_AGENT = `Keepsake/${VERSION} (self-hosted household gift app; https://github.com/ArjunRachithcf/keepsake)`;

/**
 * The Web Push services browsers subscribe with (Chrome and Android, Firefox, Safari and iOS, Edge): a subscription's
 * endpoint must be on one of them (push/push.ts), so a subscription can never make Keepsake post anywhere else.
 */
export const PUSH_HOSTS: readonly Host[] = Object.freeze([
  'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com',
  /^[a-z0-9-]{1,63}\.notify\.windows\.com$/,
]);

export interface Response { status: number; type: string; body: Buffer; url: string }

/** Why a request did not happen or was cut off. `status` is the answer's when there was one. */
export class EgressError extends Error {
  constructor(readonly reason: 'off' | 'not-allowed' | 'private-address' | 'redirect' | 'too-large' | 'timeout' | 'type' | 'encoding' | 'status' | 'network', message: string, readonly status?: number) {
    super(message);
    this.name = 'EgressError';
  }
}

export interface Request { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: Buffer }
export interface Egress {
  /** GET (or POST, for a push) to `url` under `rules`; the answer within the limits for `want`. */
  request(url: string, rules: Rules, want: Want, req?: Request): Promise<Response>;
}

// Addresses that are not the public internet (IANA special-purpose registries), as Philobiblos' egress has them.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
// Within 2000::/3: the IETF protocol assignments (2001::/23), documentation (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16).
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(net, bits, 'ipv6');

/** True for an address on the public internet. IPv6 must be global unicast; a v4-mapped address counts as its v4. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return !blocked.check(addr, 'ipv4');
  if (v !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPublicAddress(mapped[1]!);
  return globalV6.check(addr, 'ipv6') && !blockedV6.check(addr, 'ipv6');
}

/** Whether a URL may be asked for under `rules`: https, no port but 443, no credentials, a listed host (never an IP). */
export function allowed(u: URL, rules: Rules): boolean {
  if (u.protocol !== 'https:' || (u.port !== '' && u.port !== '443') || u.username || u.password) return false;
  if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) return false;
  return rules.hosts.some((h) => (typeof h === 'string' ? h === u.hostname : h.test(u.hostname)));
}

export type Resolve = (host: string) => Promise<LookupAddress[]>;
const systemResolve: Resolve = (host) => new Promise((ok, fail) => dnsLookup(host, { all: true, verbatim: true }, (e, a) => (e ? fail(e) : ok(a))));

export interface EgressOptions {
  /** false: nothing leaves (KEEPSAKE_EGRESS=off). */
  enabled?: boolean;
  resolve?: Resolve;
  timeoutMs?: number;
  /**
   * Tests only (Philobiblos' harness): a CA to trust besides the system's, the local port that stands in for 443, and
   * who counts as public (their servers are on 127.0.0.1). The connection is TLS as always, the certificate checked
   * against the name (PR #12 review, L3).
   */
  test?: { isPublic?: (addr: string) => boolean; ca?: string; httpsPort?: number };
}

export function createEgress(o: EgressOptions = {}): Egress {
  const resolve = o.resolve ?? systemResolve;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const isPublic = o.test?.isPublic ?? isPublicAddress;
  const timeout = (host: string) => new EgressError('timeout', `${host} took longer than ${timeoutMs} ms`);

  async function addressFor(host: string, signal: AbortSignal): Promise<LookupAddress> {
    let all: LookupAddress[];
    // The lookup is inside the deadline too: a resolver that never answers is cut off with the rest.
    const aborted = new Promise<never>((_, fail) => {
      if (signal.aborted) fail(timeout(host));
      signal.addEventListener('abort', () => fail(timeout(host)), { once: true });
    });
    aborted.catch(() => {});
    try { all = await Promise.race([resolve(host), aborted]); } catch (e) { throw e instanceof EgressError ? e : new EgressError('network', `cannot resolve ${host}`); }
    if (!all.length) throw new EgressError('network', `cannot resolve ${host}`);
    // Every answer must be public, not just the first: a mixed answer is a rebinding attempt.
    if (all.some((a) => !isPublic(a.address))) throw new EgressError('private-address', `${host} resolves to a private address`);
    return all[0]!;
  }

  function once(u: URL, want: Want, req: Request, signal: AbortSignal): Promise<http.IncomingMessage> {
    return addressFor(u.hostname, signal).then((addr) => new Promise((ok, fail) => {
      // The connection goes to the address checked above; the name stays for TLS (SNI and the certificate).
      const lookup: LookupFunction = (_h, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [addr]);
        else cb(null, addr.address, addr.family);
      };
      const body = req.body ?? Buffer.alloc(0);
      const r = https.request(u, {
        ...(o.test?.httpsPort ? { port: o.test.httpsPort } : {}), ...(o.test?.ca ? { ca: o.test.ca } : {}),
        method: req.method ?? 'GET', lookup, signal, agent: false,
        // The caller's headers first, the client's own last: no caller brings compression back or changes who we say
        // we are (PR #12 review, L5).
        headers: {
          ...req.headers,
          'user-agent': USER_AGENT, accept: want === 'html' ? 'text/html' : '*/*', 'accept-encoding': 'identity',
          ...(req.method === 'POST' ? { 'content-length': String(body.length) } : {}),
        },
      }, ok);
      r.on('error', (e) => fail(signal.aborted ? timeout(u.hostname) : new EgressError('network', `${u.hostname}: ${(e as NodeJS.ErrnoException).code ?? 'request failed'}`)));
      r.end(req.method === 'POST' ? body : undefined);
    }));
  }

  return {
    async request(url, rules, want, req = {}) {
      if (o.enabled === false) throw new EgressError('off', 'outgoing requests are turned off (KEEPSAKE_EGRESS=off)');
      let u: URL;
      try { u = new URL(url); } catch { throw new EgressError('not-allowed', 'not a web address'); }
      if (!allowed(u, rules)) throw new EgressError('not-allowed', `${u.protocol}//${u.host} is not on the ${rules.name} list`);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        for (let hop = 0; ; hop++) {
          const res = await once(u, want, req, ctl.signal);
          const status = res.statusCode ?? 0;
          // A push service's answer: its status only, the body never read (Philobiblos' push; PR #12 review, L4), so a
          // 410 with a body or an encoding is still a 410.
          if (want === 'push') {
            res.destroy();
            if (status < 200 || status >= 300) throw new EgressError('status', `${u.hostname} answered ${status}`, status);
            return { status, type: '', body: Buffer.alloc(0), url: u.toString() };
          }
          if (status >= 300 && status < 400 && res.headers.location && want === 'html') {
            // Never read a body nobody wants: the connection is closed, not drained.
            res.destroy();
            if (hop >= MAX_REDIRECTS) throw new EgressError('redirect', `more than ${MAX_REDIRECTS} redirects`);
            let next: URL;
            try { next = new URL(res.headers.location, u); } catch { throw new EgressError('redirect', 'a redirect to no address'); }
            if (!allowed(next, rules)) throw new EgressError('redirect', `redirect to ${next.protocol}//${next.host} refused`);
            u = next;
            continue;
          }
          const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (encoding !== 'identity') { res.destroy(); throw new EgressError('encoding', `${u.hostname} sent ${encoding} content`); }
          const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (status < 200 || status >= 300) { res.destroy(); throw new EgressError('status', `${u.hostname} answered ${status}`, status); }
          if (!TYPES[want].test(type)) { res.destroy(); throw new EgressError('type', `${u.hostname} sent ${type || 'no content type'}, not ${want}`); }
          const limit = LIMITS[want];
          if (Number(res.headers['content-length'] ?? 0) > limit) { res.destroy(); throw new EgressError('too-large', `${u.hostname} sent more than ${limit} bytes`); }
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const c of res as AsyncIterable<Buffer>) {
              size += c.length;
              if (size > limit) { res.destroy(); throw new EgressError('too-large', `${u.hostname} sent more than ${limit} bytes`); }
              chunks.push(c);
            }
          } catch (e) {
            if (e instanceof EgressError) throw e;
            throw ctl.signal.aborted ? timeout(u.hostname) : new EgressError('network', `${u.hostname}: the answer broke off`);
          }
          return { status, type, body: Buffer.concat(chunks), url: u.toString() };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
