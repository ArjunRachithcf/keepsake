// Standalone sign-in, step by step (Philobiblos ADR 0010), with a stand-in authenticator (helpers.fakeWebAuthn). The
// first admin comes from the setup link in the data folder, never from the first visitor.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { createInvite, createRecoveryLink, ensureSetupLink, findInvite, SETUP_FILE } from '../src/auth/invites';
import { FRESH_MINUTES, IDLE_DAYS, createSession, liveSession } from '../src/auth/sessions';
import { hashToken } from '../src/auth/tokens';
import { Challenges } from '../src/auth/webauthn';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household, sessionCookie } from './helpers';

const H = { origin: ORIGIN };
let cfg: Config;
let db: Db;
let app: BuiltApp['app'];

beforeEach(async () => {
  cfg = loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: mkdtempSync(join(tmpdir(), 'keepsake-auth-')), KEEPSAKE_KEYS_DIR: join(mkdtempSync(join(tmpdir(), 'keepsake-keys-')), 'keys') });
  db = openDb(':memory:');
  app = (await buildApp(cfg, db, { webauthn: fakeWebAuthn() })).app;
});
afterEach(() => app.close());

const post = (url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload, headers: { ...H, ...headers } });
async function enrol(token: string, name?: string, credId = 'cred-1') {
  const o = await post('/api/auth/enrol/options', { token, ...(name ? { name } : {}) });
  expect(o.statusCode, o.body).toBe(200);
  const { challengeId, options } = o.json();
  return post('/api/auth/enrol/verify', { challengeId, response: { id: credId, challenge: options.challenge }, label: 'Laptop' });
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === '__Host-keepsake_session');
  return c ? `__Host-keepsake_session=${c.value}` : '';
};
const setupToken = () => readFileSync(join(cfg.keysDir, SETUP_FILE), 'utf8').trim().split('#')[1]!;

describe('the first admin', () => {
  it('an empty install has no admin and lets nobody in; the setup link is in a private file, used once, then removed', async () => {
    expect((await app.inject({ url: '/api/household' })).statusCode).toBe(401);
    const file = ensureSetupLink(db, cfg)!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^${ORIGIN}/setup#[A-Za-z0-9_-]{43}\\n$`));
    expect((await app.inject({ url: '/api/auth/session' })).json()).toEqual({ mode: 'standalone', signedIn: false, setupNeeded: true });

    const token = setupToken();
    const res = await enrol(token, 'Alex');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ signedIn: true, person: { name: 'Alex', role: 'admin', signsIn: true } });
    expect(res.cookies.find((c) => c.name === '__Host-keepsake_session')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(existsSync(file)).toBe(false);
    expect((await app.inject({ url: '/api/household', headers: { cookie: cookieOf(res) } })).json().me.role).toBe('admin');
    expect((await post('/api/auth/enrol/options', { token, name: 'Mallory' })).statusCode).toBe(401);
    expect(ensureSetupLink(db, cfg)).toBeNull();
  });

  it('the session cookie is __Host- only: one a sibling subdomain could plant (no prefix) is no session (Gate routes L1)', async () => {
    db.insert(t.person).values({ id: 'p_robin', name: 'Robin', role: 'adult', createdAt: new Date().toISOString() }).run();
    const live = createSession(db, 'p_robin').token;
    const session = (cookie: string) => app.inject({ url: '/api/auth/session', headers: { cookie } }).then((r) => r.json().signedIn);
    expect([await session(`keepsake_session=${live}`), await session(`__Host-keepsake_session=${live}`)]).toEqual([false, true]);
  });

  it('a new start-up replaces the setup link; a link planted at the path is not followed', () => {
    ensureSetupLink(db, cfg);
    const first = setupToken();
    const target = join(cfg.keysDir, 'elsewhere.txt');
    writeFileSync(target, 'keep me');
    const file = join(cfg.keysDir, SETUP_FILE);
    // someone replaces the file with a link to another file: the next write removes the link, not the target
    rmSync(file);
    symlinkSync(target, file);
    ensureSetupLink(db, cfg);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(findInvite(db, first)).toBeNull();
    expect(findInvite(db, setupToken())).not.toBeNull();
  });

  it('needs a name; a wrong or reused challenge fails', async () => {
    ensureSetupLink(db, cfg);
    expect((await post('/api/auth/enrol/options', { token: setupToken() })).statusCode).toBe(400);
    const o = (await post('/api/auth/enrol/options', { token: setupToken(), name: 'Alex' })).json();
    expect((await post('/api/auth/enrol/verify', { challengeId: o.challengeId, response: { id: 'c', challenge: 'other' } })).statusCode).toBe(401);
    expect((await post('/api/auth/enrol/verify', { challengeId: o.challengeId, response: { id: 'c', challenge: o.options.challenge } })).statusCode).toBe(401);
  });
});

describe('sign-in', () => {
  async function adminWithPasskey() {
    ensureSetupLink(db, cfg);
    await enrol(setupToken(), 'Alex', 'cred-alex');
  }

  it('a sign-in clears this browser\'s guest cookie and ends its guest sessions (review L-2)', async () => {
    await adminWithPasskey();
    const alex = db.select().from(t.person).get()!.id;
    db.insert(t.guestLink).values({ id: 'l_x', kind: 'share', personId: alex, label: 'x', tokenHash: 'h', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() }).run();
    const now = new Date().toISOString();
    const device = 'd'.repeat(43);
    db.insert(t.guestSession).values([
      { id: 's1', linkId: 'l_x', deviceHash: hashToken(device), createdAt: now, lastSeenAt: now, expiresAt: '2999-01-01T00:00:00.000Z' },
      { id: 's2', linkId: 'l_x', deviceHash: hashToken('e'.repeat(43)), createdAt: now, lastSeenAt: now, expiresAt: '2999-01-01T00:00:00.000Z' },
    ]).run();
    const o = (await post('/api/auth/sign-in/options')).json();
    const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response: { id: 'cred-alex', challenge: o.options.challenge } }, { cookie: `__Host-keepsake_guest=${device}` });
    expect(res.statusCode, res.body).toBe(200);
    const cleared = [res.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('__Host-keepsake_guest=;'))!;
    // With the attributes it was set with, or a browser ignores the clearing of a __Host- cookie (fifth review, L-a).
    for (const a of ['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) expect(cleared.split('; '), a).toContain(a);
    expect(db.select().from(t.guestSession).all().map((x) => x.id)).toEqual(['s2']);
  });

  it('a passkey signs in, sign-out ends the session', async () => {
    await adminWithPasskey();
    const o = (await post('/api/auth/sign-in/options')).json();
    const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response: { id: 'cred-alex', challenge: o.options.challenge } });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = cookieOf(res);
    expect((await app.inject({ url: '/api/household', headers: { cookie } })).statusCode).toBe(200);
    expect(db.select().from(t.passkey).where(eq(t.passkey.id, 'cred-alex')).get()!.counter).toBe(1);
    expect((await post('/api/auth/sign-out', undefined, { cookie })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/household', headers: { cookie } })).statusCode).toBe(401);
  });

  it('an unknown passkey and a bad signature get the same answer', async () => {
    await adminWithPasskey();
    for (const response of [{ id: 'nobody', challenge: 'x' }, { id: 'cred-alex', challenge: 'wrong' }]) {
      const o = (await post('/api/auth/sign-in/options')).json();
      const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'that passkey did not sign you in' });
    }
  });

  it('a kid signs in with their own passkey', async () => {
    await adminWithPasskey();
    db.insert(t.person).values({ id: 'p_kid', name: 'Mia', role: 'kid', createdAt: new Date().toISOString() }).run();
    db.insert(t.passkey).values({ id: 'cred-kid', personId: 'p_kid', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const o = (await post('/api/auth/sign-in/options')).json();
    const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response: { id: 'cred-kid', challenge: o.options.challenge } });
    expect(res.json().person).toMatchObject({ name: 'Mia', role: 'kid' });
  });

  it('sign-in steps are rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await post('/api/auth/sign-in/options')).statusCode;
    expect(last).toBe(429);
  });

  it('one address cannot use up another\'s budget: refused tries do not count towards the global 300', async () => {
    const from = (remoteAddress: string) => app.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: H, remoteAddress });
    // 400 tries from one address: 20 let through, the rest refused by its own limit (and not counted globally).
    const flood = [];
    for (let i = 0; i < 400; i++) flood.push((await from('192.0.2.7')).statusCode);
    expect(flood.filter((c) => c === 200)).toHaveLength(20);
    // Another client still has all of its own 20.
    const other = [];
    for (let i = 0; i < 20; i++) other.push((await from('198.51.100.9')).statusCode);
    expect(other.every((c) => c === 200)).toBe(true);
  });

  it('the five sign-in steps share one budget of 20 a minute per client (Gate routes L3)', async () => {
    const routes = ['/api/auth/sign-in/options', '/api/auth/sign-in/verify', '/api/auth/enrol/options', '/api/auth/enrol/verify', '/api/guest/session'];
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await app.inject({ method: 'POST', url: routes[i % 5]!, headers: H, payload: {}, remoteAddress: '192.0.2.44' })).statusCode);
    expect([codes.slice(0, 20).includes(429), codes.slice(20)]).toEqual([false, [429, 429, 429, 429, 429]]);
  });

  it('IPv6 counts by /64: one host cannot spread its tries over its addresses', async () => {
    const from = (remoteAddress: string) => app.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: H, remoteAddress });
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await from(`2001:db8:7:7::${(i + 1).toString(16)}`)).statusCode);
    expect(codes.at(-1)).toBe(429);
    expect((await from('2001:db8:7:8::1')).statusCode).toBe(200);
  });
});

describe('invites', () => {
  let hh: Db;
  let a: BuiltApp['app'];
  beforeEach(async () => { hh = household(); a = (await buildApp(cfg, hh, { webauthn: fakeWebAuthn() })).app; });
  afterEach(() => a.close());
  const call = (url: string, cookie: string, payload?: object) => a.inject({ method: 'POST', url, payload, headers: { ...H, cookie } });
  async function enrolWith(token: string, credId: string) {
    const o = (await call('/api/auth/enrol/options', '', { token })).json();
    return call('/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: credId, challenge: o.options.challenge }, label: 'Phone' });
  }
  const stale = (personId: string) => `__Host-keepsake_session=${createSession(hh, personId, null, new Date(Date.now() - (FRESH_MINUTES + 1) * 60_000)).token}`;

  it('an admin invites someone without a passkey (a kid too), with a fresh sign-in; once only', async () => {
    expect((await call('/api/people/p_sam/invites', stale('p_alex'))).statusCode).toBe(403);
    expect((await call('/api/people/p_sam/invites', sessionCookie(hh, 'p_sam'))).statusCode).toBe(403);
    const inv = await call('/api/people/p_mia/invites', sessionCookie(hh, 'p_alex'));
    expect(inv.statusCode).toBe(201);
    expect(inv.json().url).toMatch(new RegExp(`^${ORIGIN}/enrol#[A-Za-z0-9_-]{43}$`));
    const v = await enrolWith(inv.json().url.split('#')[1], 'cred-mia');
    expect(v.json().person).toMatchObject({ id: 'p_mia', role: 'kid', signsIn: true });
    expect((await call('/api/people/p_mia/invites', sessionCookie(hh, 'p_alex'))).statusCode).toBe(409);
  });

  it('you add a passkey on another device with your own link; it needs a fresh sign-in', async () => {
    expect((await call('/api/me/passkeys/invite', stale('p_alex'))).statusCode).toBe(403);
    const inv = await call('/api/me/passkeys/invite', sessionCookie(hh, 'p_alex'));
    expect(inv.statusCode).toBe(201);
    expect((await enrolWith(inv.json().url.split('#')[1], 'cred-alex-phone')).json().person).toMatchObject({ id: 'p_alex' });
  });

  it('a passkey that is already enrolled answers 409', async () => {
    const inv = await call('/api/me/passkeys/invite', sessionCookie(hh, 'p_alex'));
    const v = await enrolWith(inv.json().url.split('#')[1], 'pk1');
    expect(v.statusCode).toBe(409);
  });

  it('the last admin who signs in stays; nobody removes themselves', async () => {
    const h = { ...H, cookie: sessionCookie(hh, 'p_alex') };
    expect((await a.inject({ method: 'PATCH', url: '/api/people/p_alex', headers: h, payload: { role: 'adult' } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'DELETE', url: '/api/people/p_alex', headers: h })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/people', headers: h, payload: { name: 'Pat', role: 'adult', extra: 1 } })).statusCode).toBe(400);
  });

  it('a recovery link is for an admin, into the same private file', () => {
    expect(() => createRecoveryLink(hh, cfg, 'p_sam')).toThrow(/no admin/);
    const file = createRecoveryLink(hh, cfg, 'p_alex');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toMatch(/\/enrol#/);
  });

  it('neither the setup link nor a recovery link is ever in the data folder (its backup), only in the keys folder (Gate routes L2)', () => {
    const empty = openDb(':memory:');
    const inData = () => readdirSync(cfg.dataDir).filter((f) => f.includes('link'));
    // One an earlier version left in data/ goes at the next write.
    writeFileSync(join(cfg.dataDir, SETUP_FILE), 'old');
    const setup = ensureSetupLink(empty, cfg)!;
    expect([dirname(setup), inData()]).toEqual([cfg.keysDir, []]);
    const recovery = createRecoveryLink(hh, cfg, 'p_alex');
    expect([dirname(recovery), inData(), statSync(cfg.keysDir).mode & 0o777]).toEqual([cfg.keysDir, [], 0o700]);
    expect(() => createRecoveryLink(hh, { ...cfg, keysDir: join(cfg.dataDir, 'keys') }, 'p_alex')).toThrow(/KEEPSAKE_KEYS_DIR/);
  });
});

describe('sessions, links and challenges expire', () => {
  it('a session ends after a week idle or 30 days', () => {
    const hh = household();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { token } = createSession(hh, 'p_alex', null, t0);
    expect(liveSession(hh, token, new Date(t0.getTime() + 86_400_000))?.personId).toBe('p_alex');
    expect(liveSession(hh, token, new Date(t0.getTime() + (IDLE_DAYS + 2) * 86_400_000))).toBeNull();
    const s2 = createSession(hh, 'p_alex', null, t0);
    for (let d = 0; d < 29; d += 5) expect(liveSession(hh, s2.token, new Date(t0.getTime() + d * 86_400_000))?.personId).toBe('p_alex');
    expect(liveSession(hh, s2.token, new Date(t0.getTime() + 31 * 86_400_000))).toBeNull();
    expect(liveSession(hh, 'not a token')).toBeNull();
  });
  it('an admin\'s invite lasts 7 days, your own link 24 hours; only the hash is stored', () => {
    const hh = household();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { token } = createInvite(hh, cfg, { kind: 'admin', personId: 'p_sam', createdBy: 'p_alex', now: t0 });
    expect(findInvite(hh, token, new Date(t0.getTime() + 6 * 86_400_000))).not.toBeNull();
    expect(findInvite(hh, token, new Date(t0.getTime() + 8 * 86_400_000))).toBeNull();
    const own = createInvite(hh, cfg, { kind: 'self', personId: 'p_alex', createdBy: 'p_alex', now: t0 });
    expect(findInvite(hh, own.token, new Date(t0.getTime() + 25 * 3_600_000))).toBeNull();
    expect(JSON.stringify(hh.select().from(t.invite).all())).not.toContain(token);
  });
  it('a challenge lasts 5 minutes and is used once', () => {
    const c = new Challenges();
    const id = c.put({ challenge: 'a', kind: 'sign-in' }, 'k', 0);
    expect(c.take(id, 'enrol', 1)).toBeNull();
    const id2 = c.put({ challenge: 'b', kind: 'sign-in' }, 'k', 0);
    expect(c.take(id2, 'sign-in', 5 * 60_000 + 1)).toBeNull();
    const id3 = c.put({ challenge: 'c', kind: 'sign-in' }, 'k', 0);
    expect(c.take(id3, 'sign-in', 1)).toMatchObject({ challenge: 'c' });
    expect(c.take(id3, 'sign-in', 2)).toBeNull();
  });
});

describe('one client cannot push out another\'s challenges', () => {
  it('each client holds 20; when all are full, the biggest holder loses its oldest', () => {
    const c = new Challenges(60_000, 30, 20);
    const mine = c.put({ challenge: 'mine', kind: 'sign-in' }, 'me', 0);
    for (let i = 0; i < 500; i++) c.put({ challenge: `flood${i}`, kind: 'sign-in' }, 'flooder', 1);
    expect(c.take(mine, 'sign-in', 2)).toMatchObject({ challenge: 'mine' });
    const others = Array.from({ length: 15 }, (_, i) => c.put({ challenge: `o${i}`, kind: 'sign-in' }, `client${i}`, 3));
    for (const id of others) expect(c.take(id, 'sign-in', 4)).not.toBeNull();
  });
});

describe('passkeys and sessions after the first (Philobiblos ADR 0010)', () => {
  let hh: Db;
  let a: BuiltApp['app'];
  beforeEach(async () => {
    hh = household(); // Alex has pk1 and pk2
    a = (await buildApp(cfg, hh, { webauthn: fakeWebAuthn() })).app;
  });
  afterEach(() => a.close());
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) => a.inject({ method, url, payload, headers: { ...H, cookie } });
  const pkSession = (personId: string, passkeyId: string) => `__Host-keepsake_session=${createSession(hh, personId, passkeyId).token}`;

  it('you list your passkeys; removing one ends the sessions it signed in; the last one stays', async () => {
    const via1 = pkSession('p_alex', 'pk1');
    const via2 = pkSession('p_alex', 'pk2');
    expect((await call('GET', '/api/me/passkeys', via1)).json().passkeys.map((k: { id: string }) => k.id).sort()).toEqual(['pk1', 'pk2']);
    expect((await call('DELETE', '/api/me/passkeys/pk2', via1)).statusCode).toBe(204);
    expect((await call('GET', '/api/household', via2)).statusCode).toBe(401);
    expect((await call('GET', '/api/household', via1)).statusCode).toBe(200);
    expect((await call('DELETE', '/api/me/passkeys/pk1', via1)).statusCode).toBe(409);
    expect((await call('DELETE', '/api/me/passkeys/nope', via1)).statusCode).toBe(404);
    // someone else's passkey is a 404 too
    hh.insert(t.passkey).values({ id: 'pk-sam', personId: 'p_sam', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    expect((await call('DELETE', '/api/me/passkeys/pk-sam', via1)).statusCode).toBe(404);
  });

  it('sign out everywhere ends every session of yours', async () => {
    const one = sessionCookie(hh, 'p_sam');
    const two = sessionCookie(hh, 'p_sam');
    const r = await call('POST', '/api/me/sessions/end', one);
    expect(r.statusCode).toBe(204);
    for (const c of [one, two]) expect((await call('GET', '/api/household', c)).statusCode).toBe(401);
  });

  it('a kid\'s parent or an admin ends someone\'s sessions; nobody else', async () => {
    const mia = sessionCookie(hh, 'p_mia');
    expect((await call('POST', '/api/people/p_mia/sessions/end', sessionCookie(hh, 'p_robin'))).statusCode).toBe(403);
    expect((await call('POST', '/api/people/p_sam/sessions/end', sessionCookie(hh, 'p_mia'))).statusCode).toBe(403);
    expect((await call('POST', '/api/people/p_mia/sessions/end', sessionCookie(hh, 'p_sam'))).statusCode).toBe(204);
    expect((await call('GET', '/api/household', mia)).statusCode).toBe(401);
    const robin = sessionCookie(hh, 'p_robin');
    expect((await call('POST', '/api/people/p_robin/sessions/end', sessionCookie(hh, 'p_alex'))).statusCode).toBe(204);
    expect((await call('GET', '/api/household', robin)).statusCode).toBe(401);
  });

  it('recovery replaces the admin\'s passkeys and ends their sessions', async () => {
    const old = pkSession('p_alex', 'pk1');
    const file = createRecoveryLink(hh, cfg, 'p_alex');
    const token = readFileSync(file, 'utf8').trim().split('#')[1]!;
    const o = (await call('POST', '/api/auth/enrol/options', '', { token })).json();
    const v = await call('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: 'cred-new', challenge: o.options.challenge } });
    expect(v.statusCode, v.body).toBe(200);
    expect(hh.select().from(t.passkey).where(eq(t.passkey.personId, 'p_alex')).all().map((k) => k.id)).toEqual(['cred-new']);
    expect((await call('GET', '/api/household', old)).statusCode).toBe(401);
  });

  it('recovery also takes the admin\'s open invites: the lost device cannot use one', async () => {
    const inv = await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_alex'));
    expect(inv.statusCode).toBe(201);
    const file = createRecoveryLink(hh, cfg, 'p_alex');
    const token = readFileSync(file, 'utf8').trim().split('#')[1]!;
    const o = (await call('POST', '/api/auth/enrol/options', '', { token })).json();
    expect((await call('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: 'cred-new', challenge: o.options.challenge } })).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/enrol/options', '', { token: inv.json().url.split('#')[1] })).statusCode).toBe(401);
  });

  it('an admin, just signed in with a passkey, resets the passkeys of someone who lost every device; audited', async () => {
    hh.insert(t.passkey).values({ id: 'pk-sam', personId: 'p_sam', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const sams = pkSession('p_sam', 'pk-sam');
    const old = (personId: string) => `__Host-keepsake_session=${createSession(hh, personId, 'pk1', new Date(Date.now() - 6 * 60_000)).token}`;
    // not someone else, not with a sign-in older than 5 minutes, never an admin's
    expect((await call('POST', '/api/people/p_sam/passkeys/reset', pkSession('p_robin', 'pk1'))).statusCode).toBe(403);
    expect((await call('POST', '/api/people/p_sam/passkeys/reset', old('p_alex'))).statusCode).toBe(403);
    const admin = await call('POST', '/api/people/p_alex/passkeys/reset', pkSession('p_alex', 'pk1'));
    expect(admin.statusCode).toBe(409);
    expect(admin.json().error).toBe('an admin recovers with keepsake recover');
    expect((await call('POST', '/api/people/p_nobody/passkeys/reset', pkSession('p_alex', 'pk1'))).statusCode).toBe(404);
    // Alex is the household's one admin: the reset is asked, and waits a day (Gate routes M1); asking again changes nothing.
    const asked = await call('POST', '/api/people/p_sam/passkeys/reset', pkSession('p_alex', 'pk1'));
    expect([asked.statusCode, asked.json()]).toEqual([200, { state: 'asked', waitsFor: 'a_day', notBefore: expect.any(String), askedBy: { id: 'p_alex', name: 'Alex' }, approvedBy: null }]);
    expect((await call('POST', '/api/people/p_sam/passkeys/reset', pkSession('p_alex', 'pk1'))).json().state).toBe('asked');
    expect(hh.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toHaveLength(1);
    // A day later: the reset, passkeys and sessions gone, then the usual invite works again.
    hh.update(t.passkeyReset).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).run();
    expect((await call('POST', '/api/people/p_sam/passkeys/reset', pkSession('p_alex', 'pk1'))).json().state).toBe('done');
    expect(hh.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toEqual([]);
    expect((await call('GET', '/api/household', sams)).statusCode).toBe(401);
    expect((await call('POST', '/api/people/p_sam/invites', pkSession('p_alex', 'pk1'))).statusCode).toBe(201);
    expect(hh.select().from(t.audit).all().map((x) => [x.actorId, x.action, x.subjectId])).toEqual([
      ['p_alex', 'reset_asked', 'p_sam'], ['p_alex', 'passkeys_reset', 'p_sam'], ['p_alex', 'invite_created', 'p_sam']]);
  });

  it('an admin who stops being one takes their unused invites along', async () => {
    hh.insert(t.passkey).values({ id: 'pk-robin', personId: 'p_robin', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    hh.update(t.person).set({ role: 'admin' }).where(eq(t.person.id, 'p_robin')).run();
    const inv = await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_robin'));
    expect(inv.statusCode).toBe(201);
    expect((await call('POST', '/api/people/p_robin', sessionCookie(hh, 'p_alex'))).statusCode).toBe(404); // not a route: PATCH is
    const demote = await a.inject({ method: 'PATCH', url: '/api/people/p_robin', payload: { role: 'adult' }, headers: { ...H, cookie: sessionCookie(hh, 'p_alex') } });
    expect(demote.statusCode).toBe(200);
    expect((await call('POST', '/api/auth/enrol/options', '', { token: inv.json().url.split('#')[1] })).statusCode).toBe(401);
  });

  it('a link that expires between the two enrolment steps no longer works', async () => {
    const inv = await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_alex'));
    const token = inv.json().url.split('#')[1];
    const o = (await call('POST', '/api/auth/enrol/options', '', { token })).json();
    hh.update(t.invite).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).run();
    const v = await call('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: 'cred-sam', challenge: o.options.challenge } });
    expect(v.statusCode).toBe(401);
    expect(hh.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toEqual([]);
  });
});

describe('the first admin\'s passkey carries their person id', () => {
  it('the user handle given to the authenticator is the id the admin gets', async () => {
    ensureSetupLink(db, cfg);
    const o = (await post('/api/auth/enrol/options', { token: setupToken(), name: 'Alex' })).json();
    const v = await post('/api/auth/enrol/verify', { challengeId: o.challengeId, response: { id: 'cred-a', challenge: o.options.challenge } });
    expect(o.options.user.id).toBe(v.json().person.id);
  });
});

describe('sign-in rate limits', () => {
  it('count each client apart behind a configured proxy, and everyone together', async () => {
    const pcfg = loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_TRUSTED_PROXY: '10.0.0.5', KEEPSAKE_DATA_DIR: cfg.dataDir });
    const b = (await buildApp(pcfg, openDb(':memory:'), { webauthn: fakeWebAuthn() })).app;
    const from = (xff: string) => b.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: { ...H, 'x-forwarded-for': xff }, remoteAddress: '10.0.0.5' });
    for (let i = 0; i < 20; i++) expect((await from('192.0.2.1')).statusCode).toBe(200);
    expect((await from('192.0.2.1')).statusCode).toBe(429);
    expect((await from('192.0.2.2')).statusCode).toBe(200); // someone else behind the same proxy still signs in
    // a forged X-Forwarded-For from anywhere but the proxy counts as the socket's address
    const direct = (xff: string) => b.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: { ...H, 'x-forwarded-for': xff }, remoteAddress: '198.51.100.7' });
    for (let i = 0; i < 20; i++) await direct(`203.0.113.${i}`);
    expect((await direct('203.0.113.99')).statusCode).toBe(429);
    // everyone together: 300 a minute
    let last = 0;
    for (let i = 0; i < 300; i++) last = (await from(`192.0.2.${100 + (i % 100)}`)).statusCode;
    expect(last).toBe(429);
    await b.close();
  });
});
