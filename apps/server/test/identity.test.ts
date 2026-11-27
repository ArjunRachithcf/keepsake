// HomersLab identity (ADR 0001, docs/security.md "For M1: identity"): the headers count only from the trusted proxy's
// socket address (::ffff: normalised; never X-Forwarded-For), are dropped from anyone else, and homerslab mode refuses
// to start without its three settings.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSetupLink, SETUP_FILE } from '../src/auth/invites';
import { openDb } from '../src/db/open';
import { REDACTED, buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { clientKey, dropUntrustedIdentity, fromTrustedProxy, prefix64, resolveIdentity } from '../src/identity';
import { ORIGIN, hl, homerslab, household, sessionCookie, standalone } from './helpers';

const PROXY = '10.89.0.2';
const cfg = homerslab(PROXY);

describe('config', () => {
  it('homerslab mode needs KEEPSAKE_ORIGIN, the edge\'s promise (HomersLab #236) and the trusted proxy', () => {
    const base = { KEEPSAKE_MODE: 'homerslab', KEEPSAKE_ORIGIN: ORIGIN, KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1', KEEPSAKE_TRUSTED_PROXY: PROXY };
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, KEEPSAKE_ORIGIN: undefined })).toThrow(/KEEPSAKE_ORIGIN/);
    expect(() => loadConfig({ ...base, KEEPSAKE_EDGE_IDENTITY: undefined })).toThrow(/KEEPSAKE_EDGE_IDENTITY/);
    expect(() => loadConfig({ ...base, KEEPSAKE_EDGE_IDENTITY: 'homerslab-v0' })).toThrow(/KEEPSAKE_EDGE_IDENTITY/);
    expect(() => loadConfig({ ...base, KEEPSAKE_TRUSTED_PROXY: '' })).toThrow(/KEEPSAKE_TRUSTED_PROXY/);
  });
  it('KEEPSAKE_TRUSTED_PROXY must be one IP address, refused loudly otherwise; IPv6 compared in one spelling', () => {
    const base = { KEEPSAKE_MODE: 'homerslab', KEEPSAKE_ORIGIN: ORIGIN, KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1' };
    for (const bad of ['edge.internal', '10.0.0.0/8', '10.0.0.1:443', '10.0.0.1,10.0.0.2', '[fd00::2]']) {
      expect(() => loadConfig({ ...base, KEEPSAKE_TRUSTED_PROXY: bad }), bad).toThrow(/one IP address/);
    }
    const v6 = loadConfig({ ...base, KEEPSAKE_TRUSTED_PROXY: 'FD00:0::0002' });
    expect(v6.trustedProxy).toBe('fd00::2');
    const h = hl('hl-sam', 'Sam', 'adult');
    expect(resolveIdentity(v6, 'fd00::2', h)?.externalId).toBe('hl-sam');
    expect(resolveIdentity(v6, 'fd00:0:0::2', h)?.externalId).toBe('hl-sam');
    expect(resolveIdentity(v6, 'fd00::3', h)).toBeNull();
    expect(loadConfig({ ...base, KEEPSAKE_TRUSTED_PROXY: '::ffff:10.0.0.2' }).trustedProxy).toBe('10.0.0.2');
  });
  it('standalone trusts no proxy for identity, whatever the environment says', () => {
    expect(loadConfig({ KEEPSAKE_TRUSTED_PROXY: '127.0.0.1' }).trustedProxy).toBeNull();
  });
});

describe('resolveIdentity', () => {
  const h = hl('hl-sam', 'Sam', 'adult');
  it('from the proxy, also as an IPv4-mapped IPv6 address', () => {
    expect(resolveIdentity(cfg, PROXY, h)).toEqual({ externalId: 'hl-sam', name: 'Sam', role: 'adult' });
    expect(resolveIdentity(cfg, `::ffff:${PROXY}`, h)?.externalId).toBe('hl-sam');
    expect(resolveIdentity(cfg, `::FFFF:${PROXY}`, h)?.externalId).toBe('hl-sam');
  });
  it('from anywhere else, or standalone, nothing', () => {
    for (const addr of ['10.89.0.3', '127.0.0.1', '::1', undefined]) expect(resolveIdentity(cfg, addr, h), String(addr)).toBeNull();
    expect(resolveIdentity(standalone(), PROXY, h)).toBeNull();
  });
  it('a repeated person header, an empty or a huge one is refused; the role exactly as sent', () => {
    expect(resolveIdentity(cfg, PROXY, { ...h, 'x-homerslab-person': ['a', 'b'] })).toBeNull();
    expect(resolveIdentity(cfg, PROXY, { ...h, 'x-homerslab-person': '  ' })).toBeNull();
    expect(resolveIdentity(cfg, PROXY, { ...h, 'x-homerslab-person': 'x'.repeat(201) })).toBeNull();
    for (const role of [' adult', 'Adult', 'superuser', undefined]) expect(resolveIdentity(cfg, PROXY, { ...h, 'x-homerslab-role': role })?.role, String(role)).toBeNull();
  });
  it('untrusted X-HomersLab-* headers are dropped, trusted ones kept', () => {
    const forged: Record<string, string | undefined> = { ...h, 'x-homerslab-anything': '1', accept: 'x' };
    dropUntrustedIdentity(cfg, '10.0.0.9', forged);
    expect(Object.keys(forged)).toEqual(['accept']);
    const real: Record<string, string | undefined> = { ...h };
    dropUntrustedIdentity(cfg, PROXY, real);
    expect(real).toEqual(h);
    expect(fromTrustedProxy(standalone(), PROXY)).toBe(false);
  });
  it('the logger redacts the identity headers and credentials', () => {
    for (const k of ['authorization', 'cookie', '"x-homerslab-person"', '"x-homerslab-name"', '"x-homerslab-role"']) expect(REDACTED.join(' ')).toContain(k);
  });
});

describe('homerslab mode', () => {
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(cfg, household()); await built.app.ready(); });
  afterAll(() => built.app.close());
  const get = (headers: Record<string, string>, remoteAddress = PROXY) => built.app.inject({ url: '/api/household', headers, remoteAddress });

  it('a person from the proxy is added the first time and kept in step', async () => {
    const first = await get(hl('hl-new', 'Jo', 'adult'));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().me).toMatchObject({ name: 'Jo', role: 'adult', signsIn: null });
    const again = (await get(hl('hl-new', 'Jo', 'admin'))).json();
    expect(again.me).toMatchObject({ id: first.json().me.id, role: 'admin' });
  });
  it('kids sign in; a missing or wrong role is refused, not guessed', async () => {
    expect((await get(hl('hl-mia', 'Mia', 'kid'))).statusCode).toBe(200);
    expect((await get({ 'x-homerslab-person': 'hl-sam' })).statusCode).toBe(403);
    expect((await get(hl('hl-sam', 'Sam', 'superuser'))).statusCode).toBe(403);
  });
  it('the headers mean nothing from another address, through X-Forwarded-For, or as ::1', async () => {
    expect((await get(hl('hl-alex', 'Alex', 'admin'), '10.89.0.3')).statusCode).toBe(401);
    expect((await get({ ...hl('hl-alex', 'Alex', 'admin'), 'x-forwarded-for': PROXY }, '10.89.0.3')).statusCode).toBe(401);
    expect((await get(hl('hl-alex', 'Alex', 'admin'), '::1')).statusCode).toBe(401);
    expect((await get(hl('hl-alex', 'Alex', 'admin'), `::ffff:${PROXY}`)).statusCode).toBe(200);
  });
  it('a session cookie means nothing under HomersLab; passkey sign-in is not offered', async () => {
    const db = household();
    const app = await buildApp(cfg, db);
    expect((await app.app.inject({ url: '/api/household', headers: { cookie: sessionCookie(db, 'p_alex') }, remoteAddress: PROXY })).statusCode).toBe(401);
    expect((await app.app.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: { origin: ORIGIN }, remoteAddress: PROXY })).statusCode).toBe(404);
    await app.app.close();
  });
  it('the session says who the edge sent', async () => {
    expect((await built.app.inject({ url: '/api/auth/session', headers: hl('hl-sam', 'Sam', 'adult'), remoteAddress: PROXY })).json())
      .toMatchObject({ mode: 'homerslab', signedIn: true, setupNeeded: false, person: { name: 'Sam' } });
    expect((await built.app.inject({ url: '/api/auth/session', headers: hl('hl-sam', 'Sam', 'adult'), remoteAddress: '10.1.1.1' })).json())
      .toEqual({ mode: 'homerslab', signedIn: false, setupNeeded: false });
  });
  it('people are HomersLab\'s (409); a kid\'s managers stay Keepsake\'s', async () => {
    const admin = { ...hl('hl-alex', 'Alex', 'admin'), origin: ORIGIN };
    expect((await built.app.inject({ method: 'POST', url: '/api/people', headers: admin, payload: { name: 'Pat', role: 'adult' }, remoteAddress: PROXY })).statusCode).toBe(409);
    const r = await built.app.inject({ method: 'PUT', url: '/api/people/p_leo/managers', headers: admin, payload: { managerIds: ['p_robin'] }, remoteAddress: PROXY });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().managers).toEqual(['p_robin']);
  });
  it('a forged header means nothing in standalone mode', async () => {
    const app = await buildApp(standalone(), household());
    expect((await app.app.inject({ url: '/api/household', headers: hl('hl-alex', 'Alex', 'admin') })).statusCode).toBe(401);
    await app.app.close();
  });
});

describe('homerslab mode: the first admin is the edge\'s', () => {
  it('an empty install writes no setup link and needs none: the first request the edge names as admin is the admin', async () => {
    const keys = join(mkdtempSync(join(tmpdir(), 'keepsake-hl-keys-')), 'keys');
    const c = homerslab(PROXY, { KEEPSAKE_KEYS_DIR: keys });
    const db = openDb(':memory:');
    expect(ensureSetupLink(db, c)).toBeNull();
    expect(existsSync(join(keys, SETUP_FILE))).toBe(false);
    const { app } = await buildApp(c, db);
    const session = await app.inject({ url: '/api/auth/session', remoteAddress: PROXY });
    expect(session.json()).toEqual({ mode: 'homerslab', signedIn: false, setupNeeded: false });
    const first = await app.inject({ url: '/api/household', headers: hl('hl-first', 'Kim', 'admin'), remoteAddress: PROXY });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().me).toMatchObject({ name: 'Kim', role: 'admin', signsIn: null });
    // and Keepsake's own sign-in is not there to be used instead
    for (const url of ['/api/auth/enrol/options', '/api/auth/sign-in/options']) {
      expect((await app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: { token: 'A'.repeat(43), name: 'Mallory' }, remoteAddress: PROXY })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: `/api/people/${first.json().me.id}/invites`, headers: { ...hl('hl-first', 'Kim', 'admin'), origin: ORIGIN }, remoteAddress: PROXY })).statusCode).toBe(404);
    expect(ensureSetupLink(db, c)).toBeNull();
    await app.close();
  });
});

describe('the sign-in limit\'s client key', () => {
  it('IPv4 as it is, IPv6 by its /64, through a configured proxy the last X-Forwarded-For address', () => {
    expect(clientKey({ rateLimitProxy: null }, '192.0.2.1', {})).toBe('192.0.2.1');
    expect(clientKey({ rateLimitProxy: null }, '::ffff:192.0.2.1', {})).toBe('192.0.2.1');
    expect(clientKey({ rateLimitProxy: null }, '2001:db8:1:2:3:4:5:6', {})).toBe('2001:db8:1:2::/64');
    expect(clientKey({ rateLimitProxy: '10.0.0.2' }, '10.0.0.2', { 'x-forwarded-for': '203.0.113.5, 2001:db8::9' })).toBe('via-proxy:2001:db8:0:0::/64');
    expect(prefix64('2001:0db8:0000:0042::1')).toBe('2001:db8:0:42::/64');
    expect(prefix64('::1')).toBe('0:0:0:0::/64');
  });
});
