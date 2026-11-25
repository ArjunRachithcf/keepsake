// Standalone sign-in, step by step (Philobiblos ADR 0010), with a stand-in authenticator (helpers.fakeWebAuthn). The
// first admin comes from the setup link in the data folder, never from the first visitor.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { createInvite, createRecoveryLink, ensureSetupLink, findInvite, SETUP_FILE } from '../src/auth/invites';
import { FRESH_MINUTES, IDLE_DAYS, createSession, liveSession } from '../src/auth/sessions';
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
  cfg = loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: mkdtempSync(join(tmpdir(), 'keepsake-auth-')) });
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
  const c = res.cookies.find((x) => x.name === 'keepsake_session');
  return c ? `keepsake_session=${c.value}` : '';
};
const setupToken = () => readFileSync(join(cfg.dataDir, SETUP_FILE), 'utf8').trim().split('#')[1]!;

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
    expect(res.cookies.find((c) => c.name === 'keepsake_session')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(existsSync(file)).toBe(false);
    expect((await app.inject({ url: '/api/household', headers: { cookie: cookieOf(res) } })).json().me.role).toBe('admin');
    expect((await post('/api/auth/enrol/options', { token, name: 'Mallory' })).statusCode).toBe(401);
    expect(ensureSetupLink(db, cfg)).toBeNull();
  });

  it('a new start-up replaces the setup link; a link planted at the path is not followed', () => {
    ensureSetupLink(db, cfg);
    const first = setupToken();
    const target = join(cfg.dataDir, 'elsewhere.txt');
    writeFileSync(target, 'keep me');
    const file = join(cfg.dataDir, SETUP_FILE);
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
  const stale = (personId: string) => `keepsake_session=${createSession(hh, personId, null, new Date(Date.now() - (FRESH_MINUTES + 1) * 60_000)).token}`;

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
    const id = c.put({ challenge: 'a', kind: 'sign-in' }, 0);
    expect(c.take(id, 'enrol', 1)).toBeNull();
    const id2 = c.put({ challenge: 'b', kind: 'sign-in' }, 0);
    expect(c.take(id2, 'sign-in', 5 * 60_000 + 1)).toBeNull();
    const id3 = c.put({ challenge: 'c', kind: 'sign-in' }, 0);
    expect(c.take(id3, 'sign-in', 1)).toMatchObject({ challenge: 'c' });
    expect(c.take(id3, 'sign-in', 2)).toBeNull();
  });
});
