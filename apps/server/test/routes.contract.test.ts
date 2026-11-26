// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec declares
// and a body that validates against the spec's schema for it; and deny by default holds (securitySchemes, Origin).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { EDGE_IDENTITY } from '../src/config';
import { PUSH_HOSTS } from '../src/net/egress';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { startGuestSession } from '../src/guests/guests';
import { today } from '../src/celebrations/dates';
import { GUEST_TOKEN, ORIGIN, expectValid, fakeWebAuthn, hl, homerslab, household, withDraws, withM4, isPublic, ops, request, security, sessionCookie, spec, standalone } from './helpers';

describe.each(['standalone', 'homerslab'] as const)('contracts/openapi.yaml (%s)', (mode) => {
  let built: BuiltApp;
  let db: Db;
  let auth: Record<string, string>;
  /** Sam's share-link guest (withM4): the /guest/* operations take this session, and only it. */
  let guest: Record<string, string>;
  beforeAll(async () => {
    db = withM4(withDraws(household()));
    auth = mode === 'standalone' ? { cookie: sessionCookie(db, 'p_alex') } : hl('hl-alex', 'Alex', 'admin');
    guest = { cookie: `__Host-keepsake_guest=${startGuestSession(db, GUEST_TOKEN, today('UTC')).device}`, 'x-keepsake-link': 'l_sam' };
    // Egress on, with stand-ins: a shop that answers a page, and push services that accept every push (nothing leaves).
    const on = { KEEPSAKE_EGRESS: 'on', KEEPSAKE_SHOP_HOSTS: 'shop.example' };
    built = await buildApp(mode === 'standalone' ? standalone(on) : homerslab('127.0.0.1', on), db, {
      webauthn: fakeWebAuthn(), pushTransport: async () => 201,
      egress: { request: async (url) => ({ status: 200, type: 'text/html', body: Buffer.from('<title>A kite</title>'), url }) },
    });
    await built.app.ready();
  });
  afterAll(() => built.app.close());

  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    expect(built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(specRoutes);
  });

  // In spec order, as the household's admin (public operations without credentials). Under HomersLab, people and
  // passkeys are HomersLab's: those answer 409 or 404, which the spec declares.
  const elsewhere = new Set(['addPerson', 'editPerson', 'removePerson', 'invitePerson', 'inviteSelf', 'listPasskeys', 'removePasskey', 'signOutEverywhere', 'endSessions', 'resetPasskeys', 'cancelPasskeyReset', 'confirmPasskeyReset']);
  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const req = request(o);
    // Signing out everywhere would end the admin's sessions for the operations after it: someone else signs out.
    const forGuest = security(o).some((s) => 'guestSession' in s);
    const who = forGuest ? guest : o.op.operationId === 'signOutEverywhere' && mode === 'standalone' ? { cookie: sessionCookie(db, 'p_robin') } : auth;
    const res = await built.app.inject({ ...req, headers: { ...req.headers, ...(isPublic(o) ? {} : who) } });
    if (!isPublic(o)) {
      if (mode === 'homerslab' && elsewhere.has(o.op.operationId)) expect([404, 409], res.body).toContain(res.statusCode);
      // A share-link guest has no draw to open: the spec's 404.
      else if (o.op.operationId === 'openGuestDraw') expect(res.statusCode, res.body).toBe(404);
      // Nobody reset Alex: nothing to confirm (Gate routes M1), the spec's 404.
      else if (o.op.operationId === 'confirmPasskeyReset') expect(res.statusCode, res.body).toBe(404);
      // Guest links wait for HomersLab's edge (Homeward #317): refused there.
      else if (mode === 'homerslab' && ['shareLink', 'inviteGuest', 'reissueLink'].includes(o.op.operationId)) expect(res.statusCode, res.body).toBe(409);
      else expect(res.statusCode, res.body).toBeLessThan(300);
    }
    expectValid(o, res.statusCode, res.body ? res.json() : undefined);
    if (o.op.operationId === 'health') expect(res.json().mode).toBe(mode);
  });

  // Deny by default: the top-level requirement holds no anonymous `{}`, and every operation's effective security is
  // non-empty with no `{}`, except health's and the sign-in steps'.
  it('only /health and the sign-in steps are open; every other operation declares 401 and 403', () => {
    const isAnonymous = (sec: unknown) => !Array.isArray(sec) || sec.length === 0 || sec.some((r) => Object.keys(r as object).length === 0);
    expect(isAnonymous(spec.security), 'top-level security').toBe(false);
    const open = ops.filter((o) => isAnonymous(o.op.security ?? spec.security)).map((o) => o.op.operationId).sort();
    expect(open).toEqual(['authSession', 'enrolOptions', 'enrolVerify', 'health', 'signInOptions', 'signInVerify', 'signOut', 'startGuest']);
    for (const o of ops.filter((x) => !isPublic(x))) expect(Object.keys(o.op.responses), o.op.operationId).toEqual(expect.arrayContaining(['401', '403']));
  });

  it.each(ops.filter((o) => !isPublic(o)).map((o) => [o.op.operationId, o] as const))('%s: 401 without a person', async (_n, o) => {
    const req = request(o);
    const anon = await built.app.inject(req);
    expect(anon.statusCode).toBe(401);
    expectValid(o, 401, anon.json());
  });

  it.each(ops.filter((o) => o.method !== 'GET').map((o) => [o.op.operationId, o] as const))('%s: refused from another origin or without one', async (_n, o) => {
    const req = request(o);
    for (const origin of ['https://evil.example', undefined]) {
      const { origin: _o, ...rest } = req.headers;
      const res = await built.app.inject({ ...req, headers: { ...rest, ...auth, ...(origin ? { origin } : {}) } });
      expect(res.statusCode).toBe(403);
      expectValid(o, 403, res.json());
    }
  });
});

describe('the HomersLab manifest', () => {
  it('asks HomersLab for the edge\'s promise and the settings, and sets none of them itself', () => {
    const m = parse(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'));
    expect(m.identity.edge).toBe(EDGE_IDENTITY);
    for (const k of ['KEEPSAKE_EDGE_IDENTITY', 'KEEPSAKE_TRUSTED_PROXY', 'KEEPSAKE_ORIGIN']) expect(Object.keys(m.env ?? {}), k).not.toContain(k);
    expect(m.audience).toBe('household');
  });

  it('names its egress: the push services the client allows, and the shops from KEEPSAKE_SHOP_HOSTS; the VAPID key as a secret file', () => {
    const m = parse(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'));
    // Philobiblos' convention (PR #12 review, N2): config as '${VAR}' in egress, the push services as push_egress.
    expect(m.network.egress).toEqual(['${KEEPSAKE_SHOP_HOSTS}']);
    expect(m.network.push_egress).toEqual(PUSH_HOSTS.map((h) => (typeof h === 'string' ? h : '*.notify.windows.com')));
    expect(Object.keys(m.network).sort()).toEqual(['egress', 'push_egress']);
    expect(m.secrets.map((x: { key: string; file: boolean }) => [x.key, x.file])).toEqual([['KEEPSAKE_SEALING_KEY', true], ['KEEPSAKE_VAPID_KEY', true]]);
    expect(Object.keys(m.env)).not.toContain('KEEPSAKE_VAPID_KEY');
  });
});

describe('the HomersLab manifest: how it must be run (Gate routes, Info)', () => {
  it('asks for the hardening docker-compose.yml and the smoke test use: a user not root, a read-only root, no capabilities, no new privileges', () => {
    const m = parse(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'));
    expect(m.runtime).toEqual({ run_as_non_root: true, read_only_root: true, tmpfs: ['/tmp'], cap_drop: ['ALL'], no_new_privileges: true, pids_limit: 64 });
    const c = parse(readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')).services.keepsake;
    expect([c.read_only, c.tmpfs, c.cap_drop, c.security_opt, c.pids_limit]).toEqual([true, ['/tmp'], ['ALL'], ['no-new-privileges:true'], 64]);
    // A field HomersLab's manifest does not have yet is asked for, not claimed (Homeward #86).
    expect(m.identity.household_api).toBe('requested');
  });
});

describe('answers', () => {
  it('a JSON body that is not JSON is a 400 in the spec\'s shape', async () => {
    const db = household();
    const { app } = await buildApp(standalone(), db);
    const res = await app.inject({ method: 'POST', url: '/api/wishes', headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN, 'content-type': 'application/json' }, payload: '{nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
    await app.close();
  });
});

describe('admins only, refused to anyone else (standalone)', () => {
  const ADMIN_ONLY = ['editHousehold', 'addPerson', 'editPerson', 'removePerson', 'setManagers', 'invitePerson', 'resetPasskeys', 'importDryRun', 'importSheet'];
  it.each(ADMIN_ONLY)('%s as a grown-up who is not an admin: 403, nothing changed', async (id) => {
    const db = household();
    const { app } = await buildApp(standalone(), db, { webauthn: fakeWebAuthn() });
    const o = ops.find((x) => x.op.operationId === id)!;
    const req = request(o);
    const before = JSON.stringify([db.select().from(t.person).all(), db.select().from(t.manager).all(), db.select().from(t.passkey).all(), db.select().from(t.invite).all(), db.select().from(t.setting).all()]);
    const res = await app.inject({ ...req, headers: { ...req.headers, cookie: sessionCookie(db, 'p_robin') } });
    expect(res.statusCode, res.body).toBe(403);
    expectValid(o, 403, res.json());
    expect(JSON.stringify([db.select().from(t.person).all(), db.select().from(t.manager).all(), db.select().from(t.passkey).all(), db.select().from(t.invite).all(), db.select().from(t.setting).all()])).toBe(before);
    await app.close();
  });
});

describe('order and position give no hidden wish away (ADR 0003)', () => {
  // Every viewer × the lists a person's wishes appear in: the wishes carry no stored position, and the answer holds
  // no id of a wish hidden from the viewer, so neither a gap nor a number counts what they cannot see.
  const viewers = ['p_alex', 'p_sam', 'p_robin', 'p_mia', 'p_leo'];
  const hiddenFrom: Record<string, string[]> = {
    p_alex: [], p_sam: ['w_leo_kite', 'w_sug_for_alex'], p_robin: ['w_mia_slime', 'w_leo_kite'],
    p_mia: ['w_leo_kite', 'w_sug_for_alex'], p_leo: ['w_mia_slime', 'w_sug_for_alex', 'w_sug_for_mia'],
  };
  it.each(viewers)('%s', async (who) => {
    const db = household();
    const { app } = await buildApp(standalone(), db);
    const cookie = sessionCookie(db, who);
    // a new listed wish for Mia from her parent, and a suggestion from Leo: their answers count nothing either
    const add = await app.inject({ method: 'POST', url: '/api/wishes', headers: { origin: ORIGIN, cookie: sessionCookie(db, 'p_sam') }, payload: { personId: 'p_mia', name: 'A scooter', celebrationId: null } });
    const sug = await app.inject({ method: 'POST', url: '/api/wishes', headers: { origin: ORIGIN, cookie: sessionCookie(db, 'p_leo') }, payload: { personId: 'p_mia', name: 'Marbles', celebrationId: null } });
    for (const r of [add, sug]) expect(r.statusCode).toBe(201);
    expect(add.json()).not.toHaveProperty('position');
    expect(sug.json()).not.toHaveProperty('position');
    for (const url of ['/api/home', '/api/people/p_mia', '/api/people/p_leo', '/api/people/p_alex', '/api/celebrations/c_xmas', '/api/celebrations/c_mia']) {
      const res = await app.inject({ url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, `${who} ${url}`).not.toContain('"position"');
      for (const w of hiddenFrom[who]!) expect(res.body, `${who} ${url} ${w}`).not.toContain(w);
    }
    await app.close();
  });
});

describe('docs/security.md (ADR 0006)', () => {
  it('names every route of the spec with its actor and control', () => {
    const doc = readFileSync(new URL('../../../docs/security.md', import.meta.url), 'utf8');
    const missing = ops.map((o) => `/api${o.path.replace(/\{\w+\}/g, '{id}')}`).filter((p) => !doc.includes(`\`${p}\``) && !doc.includes(` ${p}\``));
    expect(missing).toEqual([]);
  });
});
