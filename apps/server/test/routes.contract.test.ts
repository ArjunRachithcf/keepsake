// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec declares
// and a body that validates against the spec's schema for it; and deny by default holds (securitySchemes, Origin).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { EDGE_IDENTITY } from '../src/config';
import type { Db } from '../src/db/open';
import { ORIGIN, expectValid, fakeWebAuthn, hl, homerslab, household, isPublic, ops, request, sessionCookie, spec, standalone } from './helpers';

describe.each(['standalone', 'homerslab'] as const)('contracts/openapi.yaml (%s)', (mode) => {
  let built: BuiltApp;
  let db: Db;
  let auth: Record<string, string>;
  beforeAll(async () => {
    db = household();
    auth = mode === 'standalone' ? { cookie: sessionCookie(db, 'p_alex') } : hl('hl-alex', 'Alex', 'admin');
    built = await buildApp(mode === 'standalone' ? standalone() : homerslab(), db, { webauthn: fakeWebAuthn() });
    await built.app.ready();
  });
  afterAll(() => built.app.close());

  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    expect(built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(specRoutes);
  });

  // In spec order, as the household's admin (public operations without credentials). Under HomersLab, people and
  // passkeys are HomersLab's: those answer 409 or 404, which the spec declares.
  const elsewhere = new Set(['addPerson', 'editPerson', 'removePerson', 'invitePerson', 'inviteSelf', 'listPasskeys', 'removePasskey', 'signOutEverywhere', 'endSessions']);
  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const req = request(o);
    // Signing out everywhere would end the admin's sessions for the operations after it: someone else signs out.
    const who = o.op.operationId === 'signOutEverywhere' && mode === 'standalone' ? { cookie: sessionCookie(db, 'p_robin') } : auth;
    const res = await built.app.inject({ ...req, headers: { ...req.headers, ...(isPublic(o) ? {} : who) } });
    if (!isPublic(o)) {
      if (mode === 'homerslab' && elsewhere.has(o.op.operationId)) expect([404, 409], res.body).toContain(res.statusCode);
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
    expect(open).toEqual(['authSession', 'enrolOptions', 'enrolVerify', 'health', 'signInOptions', 'signInVerify', 'signOut']);
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

describe('docs/security.md (ADR 0006)', () => {
  it('names every route of the spec with its actor and control', () => {
    const doc = readFileSync(new URL('../../../docs/security.md', import.meta.url), 'utf8');
    const missing = ops.map((o) => `/api${o.path.replace(/\{\w+\}/g, '{id}')}`).filter((p) => !doc.includes(`\`${p}\``) && !doc.includes(` ${p}\``));
    expect(missing).toEqual([]);
  });
});
