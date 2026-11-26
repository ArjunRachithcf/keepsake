// The Gate's routes review (issue #6, comment 7180855731), M1, decided by Arjun: an admin alone can no longer become
// someone else (reset, invite, enrol) and open their draw, and demoting an admin first does not get round "never an
// admin's passkeys". The red team's probe, kept as a test the other way round.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household, sessionCookie, standalone, withDraws } from './helpers';

const apps: BuiltApp[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.app.close(); });
const NOW = new Date().toISOString();

/** Christmas drawn with Alex (admin, host), Sam, Robin and Mia; Sam and Robin sign in with a passkey. */
async function start(o: { robinAdmin?: boolean } = {}) {
  const db = withDraws(household());
  for (const p of ['p_sam', 'p_robin']) db.insert(t.passkey).values({ id: `pk-${p}`, personId: p, publicKey: Buffer.from([1]), label: 'x', createdAt: NOW }).run();
  if (o.robinAdmin) db.update(t.person).set({ role: 'admin' }).where(eq(t.person.id, 'p_robin')).run();
  const built = await buildApp(standalone(), db, { webauthn: fakeWebAuthn() });
  apps.push(built);
  /** A sign-in with a passkey just now: what a reset needs. */
  const fresh = (personId: string) => `__Host-keepsake_session=${createSession(db, personId, personId === 'p_alex' ? 'pk1' : `pk-${personId}`).token}`;
  const send = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, cookie: string, payload?: object) =>
    built.app.inject({ method, url, payload, headers: { origin: ORIGIN, cookie } });
  const drawn = await send('POST', '/api/celebrations/c_xmas/draw/run', fresh('p_alex'));
  expect(drawn.statusCode, drawn.body).toBe(200);
  return { db, built, fresh, send };
}
type Home = Awaited<ReturnType<typeof start>>;
const reset = (h: Home, who: string, whom: string) => h.send('POST', `/api/people/${whom}/passkeys/reset`, h.fresh(who));
const audit = (db: Db) => db.select().from(t.audit).all().map((a) => [a.actorId, a.action, a.subjectId]).filter(([, a]) => !['drawn', 'draw_changed'].includes(a!));
const notices = async (h: Home, who: string) => { await h.built.pusher.idle(); return ((await h.send('GET', '/api/notices', sessionCookie(h.db, who))).json().notices as { kind: string; person: { id: string }; by: { id: string } | null }[]).filter((n) => n.kind !== 'draw').map((n) => [n.kind, n.person?.id, n.by?.id]); };

describe('routes M1 (probe): an admin alone does not become Sam', () => {
  it('one admin: the reset waits a day (Sam keeps his passkeys, no invite); done, Sam and his draw are told, and his draw stays sealed until he confirms', async () => {
    const h = await start();
    const asked = await reset(h, 'p_alex', 'p_sam');
    expect(asked.json()).toMatchObject({ state: 'asked', waitsFor: 'a_day' });
    // The probe's next step, an invite to enrol as Sam, is refused: Sam still signs in.
    expect((await h.send('POST', '/api/people/p_sam/invites', h.fresh('p_alex'))).statusCode).toBe(409);
    expect(await notices(h, 'p_sam')).toEqual([['reset_asked', 'p_sam', 'p_alex']]);
    // A day later the asker carries it out alone.
    h.db.update(t.passkeyReset).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).run();
    expect((await reset(h, 'p_alex', 'p_sam')).json().state).toBe('done');
    const inv = await h.send('POST', '/api/people/p_sam/invites', h.fresh('p_alex'));
    expect(inv.statusCode).toBe(201);
    const o = (await h.send('POST', '/api/auth/enrol/options', '', { token: inv.json().url.split('#')[1] })).json();
    const enrolled = await h.send('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: 'cred-new', challenge: o.options.challenge }, label: 'New phone' });
    expect(enrolled.json().person).toMatchObject({ id: 'p_sam' });
    // Signed in as Sam on the new device: the draw stays sealed.
    const sam = String([enrolled.headers['set-cookie']].flat()[0]).split(';')[0]!;
    const open = await h.send('POST', '/api/celebrations/c_xmas/draw/open', sam);
    expect([open.statusCode, open.json()]).toEqual([409, { error: 'confirm the reset of your sign-in first' }]);
    expect((await h.send('GET', '/api/celebrations/c_xmas/draw', sam)).json().mine).toMatchObject({ sealed: true, canOpen: false, receiver: null });
    // Told: Sam, and everyone else in his open draw.
    for (const who of ['p_robin', 'p_mia', 'p_alex']) expect(await notices(h, who), who).toContainEqual(['signin_reset', 'p_sam', 'p_alex']);
    expect(await notices(h, 'p_leo')).toEqual([]);
    expect((await h.send('POST', '/api/me/reset/confirm', sam)).statusCode).toBe(204);
    expect((await h.send('POST', '/api/celebrations/c_xmas/draw/open', sam)).statusCode).toBe(200);
    expect(audit(h.db)).toEqual([['p_alex', 'reset_asked', 'p_sam'], ['p_alex', 'passkeys_reset', 'p_sam'], ['p_alex', 'invite_created', 'p_sam'], ['p_sam', 'reset_confirmed', 'p_sam']]);
  });

  it('two admins: the reset is done by the second admin\'s yes, never by the asker alone', async () => {
    const h = await start({ robinAdmin: true });
    {
      expect((await reset(h, 'p_alex', 'p_sam')).json()).toMatchObject({ state: 'asked', waitsFor: 'another_admin', notBefore: null });
      expect(await notices(h, 'p_robin')).toEqual([['reset_asked', 'p_sam', 'p_alex']]);
      // However long Alex waits, alone he does not carry it out.
      expect((await reset(h, 'p_alex', 'p_sam')).json().state).toBe('asked');
      expect(h.db.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toHaveLength(1);
      expect((await reset(h, 'p_robin', 'p_sam')).json().state).toBe('done');
      expect(h.db.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toEqual([]);
    }
  });

  it('demoting an admin first does not get round it: a lately demoted admin is never reset; the demotion is audited', async () => {
    const h = await start({ robinAdmin: true });
    expect((await h.send('PATCH', '/api/people/p_robin', h.fresh('p_alex'), { role: 'adult' })).statusCode).toBe(200);
    const r = await reset(h, 'p_alex', 'p_robin');
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'an admin recovers with keepsake recover' }]);
    expect(audit(h.db)).toEqual([['p_alex', 'role_changed', 'p_robin']]);
    // 30 days on, they are a grown-up like any other.
    h.db.update(t.person).set({ adminUntil: new Date(Date.now() - 1000).toISOString() }).where(eq(t.person.id, 'p_robin')).run();
    expect((await reset(h, 'p_alex', 'p_robin')).json().state).toBe('asked');
  });

  it('Sam, who still has a device, calls it off; so may an admin; then it starts again from the beginning', async () => {
    const h = await start();
    await reset(h, 'p_alex', 'p_sam');
    expect((await h.send('DELETE', '/api/people/p_sam/passkeys/reset', h.fresh('p_robin'))).statusCode).toBe(403);
    expect((await h.send('DELETE', '/api/people/p_sam/passkeys/reset', h.fresh('p_sam'))).statusCode).toBe(204);
    expect((await h.send('DELETE', '/api/people/p_sam/passkeys/reset', h.fresh('p_sam'))).statusCode).toBe(404);
    h.db.update(t.passkeyReset).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).run();
    expect((await reset(h, 'p_alex', 'p_sam')).json()).toMatchObject({ state: 'asked', waitsFor: 'a_day' });
    expect(audit(h.db).map((a) => a[1])).toEqual(['reset_asked', 'reset_cancelled', 'reset_asked']);
  });
});
