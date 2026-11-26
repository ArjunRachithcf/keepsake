// The Gate's routes review (issue #6, comment 7180855731), M1, decided by Arjun: an admin alone can no longer become
// someone else (reset, invite, enrol) and open their draw, and demoting an admin first does not get round "never an
// admin's passkeys". The red team's probe, kept as a test the other way round; and the re-attack's (B1): a "second
// admin" the asker made for the occasion is nobody's yes, and the person is warned before anything is reset.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import { hashToken } from '../src/auth/tokens';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household, sessionCookie, standalone, withDraws } from './helpers';
import { countingTransport } from './m4';

const apps: BuiltApp[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.app.close(); });
const NOW = new Date().toISOString();
const MONTH_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString();

/**
 * Christmas drawn with Alex (admin, host), Sam, Robin and Mia; Sam and Robin sign in with a passkey of a month ago
 * (Robin an admin as long, with `robinAdmin`). Sam's phone is subscribed to push with the session it signed in with.
 */
async function start(o: { robinAdmin?: boolean } = {}) {
  const db = withDraws(household());
  for (const p of ['p_sam', 'p_robin']) db.insert(t.passkey).values({ id: `pk-${p}`, personId: p, publicKey: Buffer.from([1]), label: 'x', createdAt: MONTH_AGO }).run();
  if (o.robinAdmin) db.update(t.person).set({ role: 'admin', adminSince: MONTH_AGO }).where(eq(t.person.id, 'p_robin')).run();
  const phone = createSession(db, 'p_sam', 'pk-p_sam');
  db.insert(t.pushSubscription).values({ id: 'ps_sam', personId: 'p_sam', sessionId: hashToken(phone.token), endpoint: 'https://fcm.googleapis.com/fcm/send/sam', p256dh: 'x', auth: 'x', createdAt: NOW, confirmedAt: NOW }).run();
  const pushes = new Map<string, number>();
  const built = await buildApp(standalone(), db, { webauthn: fakeWebAuthn(), pushTransport: countingTransport(pushes) });
  apps.push(built);
  /** A sign-in with a passkey just now: what a reset needs. */
  const fresh = (personId: string) => `__Host-keepsake_session=${createSession(db, personId, personId === 'p_alex' ? 'pk1' : `pk-${personId}`).token}`;
  const send = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', url: string, cookie: string, payload?: object) =>
    built.app.inject({ method, url, payload, headers: { origin: ORIGIN, cookie } });
  const drawn = await send('POST', '/api/celebrations/c_xmas/draw/run', fresh('p_alex'));
  expect(drawn.statusCode, drawn.body).toBe(200);
  return { db, built, fresh, send, pushes, phone: `__Host-keepsake_session=${phone.token}` };
}
type Home = Awaited<ReturnType<typeof start>>;
const reset = (h: Home, who: string, whom: string) => h.send('POST', `/api/people/${whom}/passkeys/reset`, h.fresh(who));
const audit = (db: Db) => db.select().from(t.audit).all().map((a) => [a.actorId, a.action, a.subjectId]).filter(([, a]) => !['drawn', 'draw_changed'].includes(a!));
const notices = async (h: Home, who: string) => { await h.built.pusher.idle(); return ((await h.send('GET', '/api/notices', sessionCookie(h.db, who))).json().notices as { kind: string; person: { id: string }; by: { id: string } | null }[]).filter((n) => n.kind !== 'draw').map((n) => [n.kind, n.person?.id, n.by?.id]); };

/** An invite from Alex, enrolled with a new passkey `cred`: the cookie of that sign-in. */
async function enrolAs(h: Home, personId: string, cred: string) {
  const inv = await h.send('POST', `/api/people/${personId}/invites`, h.fresh('p_alex'));
  expect(inv.statusCode, inv.body).toBe(201);
  const o = (await h.send('POST', '/api/auth/enrol/options', '', { token: inv.json().url.split('#')[1] })).json();
  const enrolled = await h.send('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: cred, challenge: o.options.challenge }, label: 'New phone' });
  expect(enrolled.json().person, enrolled.body).toMatchObject({ id: personId });
  return String([enrolled.headers['set-cookie']].flat()[0]).split(';')[0]!;
}
const passkeysOf = (h: Home, personId: string) => h.db.select().from(t.passkey).where(eq(t.passkey.personId, personId)).all();
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

describe('routes M1 (probe): an admin alone does not become Sam', () => {
  it('one admin: the reset waits a day, Sam warned at once on his phone and his sessions kept; done, everyone told, his draw sealed until he confirms', async () => {
    const h = await start();
    const asked = await reset(h, 'p_alex', 'p_sam');
    expect(asked.json()).toMatchObject({ state: 'asked', waitsFor: 'a_day', approvedBy: null });
    // The probe's next step, an invite to enrol as Sam, is refused: Sam still signs in.
    expect((await h.send('POST', '/api/people/p_sam/invites', h.fresh('p_alex'))).statusCode).toBe(409);
    // Warned at the ask (re-attack B1): a notice and a push to his phone, whose session still works; told too, the
    // people of his draw.
    expect(await notices(h, 'p_sam')).toEqual([['reset_asked', 'p_sam', 'p_alex']]);
    expect(h.pushes.get('p_sam')).toBe(1);
    expect((await h.send('GET', '/api/home', h.phone)).statusCode).toBe(200);
    for (const who of ['p_robin', 'p_mia']) expect(await notices(h, who), who).toEqual([['reset_asked', 'p_sam', 'p_alex']]);
    // A day later the asker carries it out alone.
    h.db.update(t.passkeyReset).set({ notBefore: new Date(Date.now() - 1000).toISOString() }).run();
    expect((await reset(h, 'p_alex', 'p_sam')).json().state).toBe('done');
    expect((await h.send('GET', '/api/home', h.phone)).statusCode).toBe(401);
    const sam = await enrolAs(h, 'p_sam', 'cred-new');
    // Signed in as Sam on the new device: the draw stays sealed.
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

  it('two long-standing admins: the second admin\'s yes counts, and the reset waits an hour after it; never the asker alone', async () => {
    const h = await start({ robinAdmin: true });
    expect((await reset(h, 'p_alex', 'p_sam')).json()).toMatchObject({ state: 'asked', waitsFor: 'a_day' });
    expect(await notices(h, 'p_robin')).toEqual([['reset_asked', 'p_sam', 'p_alex']]);
    // However often Alex calls, alone he does not carry it out.
    expect((await reset(h, 'p_alex', 'p_sam')).json().state).toBe('asked');
    const yes = (await reset(h, 'p_robin', 'p_sam')).json();
    expect(yes).toMatchObject({ state: 'asked', waitsFor: 'an_hour', approvedBy: { id: 'p_robin' } });
    expect(Date.parse(yes.notBefore) - Date.now()).toBeGreaterThan(59 * 60_000);
    // Within the hour nothing is reset: Sam still signs in, and can call it off.
    for (const who of ['p_alex', 'p_robin']) expect((await reset(h, who, 'p_sam')).json().state).toBe('asked');
    expect(passkeysOf(h, 'p_sam')).toHaveLength(1);
    expect((await h.send('GET', '/api/home', h.phone)).statusCode).toBe(200);
    h.db.update(t.passkeyReset).set({ approvedAt: hoursAgo(2) }).run();
    expect((await reset(h, 'p_alex', 'p_sam')).json().state).toBe('done');
    expect(passkeysOf(h, 'p_sam')).toEqual([]);
    expect(audit(h.db)).toEqual([['p_alex', 'reset_asked', 'p_sam'], ['p_robin', 'reset_approved', 'p_sam'], ['p_alex', 'passkeys_reset', 'p_sam']]);
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

describe('re-attack B1 (probe): a "second admin" the asker made is nobody\'s yes', () => {
  it('Alex makes Helper an admin, enrols them from his own invite, asks, and Helper says yes: it still waits the day, and Sam is warned', async () => {
    const h = await start();
    const made = await h.send('POST', '/api/people', h.fresh('p_alex'), { name: 'Helper', role: 'admin' });
    expect(made.statusCode).toBe(201);
    const helperId = made.json().id as string;
    await enrolAs(h, helperId, 'cred-helper');
    const helper = () => `__Host-keepsake_session=${createSession(h.db, helperId, 'cred-helper').token}`;
    expect((await reset(h, 'p_alex', 'p_sam')).json()).toMatchObject({ state: 'asked', waitsFor: 'a_day' });
    const r = await h.send('POST', '/api/people/p_sam/passkeys/reset', helper());
    expect(r.json()).toMatchObject({ state: 'asked', waitsFor: 'a_day', approvedBy: null });
    // Even had Alex waited a month with Helper: their passkey came from his invite.
    h.db.update(t.person).set({ adminSince: MONTH_AGO }).where(eq(t.person.id, helperId)).run();
    h.db.update(t.passkey).set({ createdAt: MONTH_AGO }).where(eq(t.passkey.personId, helperId)).run();
    h.db.update(t.passkeyReset).set({ askedAt: NOW }).run();
    expect((await h.send('POST', '/api/people/p_sam/passkeys/reset', helper())).json()).toMatchObject({ state: 'asked', approvedBy: null });
    expect(passkeysOf(h, 'p_sam')).toHaveLength(1);
    // Sam heard of it on his phone at once, and nothing ended his session; Helper's making is in the audit.
    await h.built.pusher.idle();
    expect([h.pushes.get('p_sam'), (await h.send('GET', '/api/home', h.phone)).statusCode]).toEqual([1, 200]);
    expect(audit(h.db).slice(0, 3)).toEqual([['p_alex', 'person_created', helperId], ['p_alex', 'invite_created', helperId], ['p_alex', 'reset_asked', 'p_sam']]);
  });

  it('an admin promoted lately, or one without a passkey of a week ago, is nobody\'s second; the promotion is audited', async () => {
    const h = await start();
    expect((await h.send('PATCH', '/api/people/p_robin', h.fresh('p_alex'), { role: 'admin' })).statusCode).toBe(200);
    await reset(h, 'p_alex', 'p_sam');
    expect((await reset(h, 'p_robin', 'p_sam')).json()).toMatchObject({ approvedBy: null, waitsFor: 'a_day' });
    // An admin of a month, whose only passkey is a day old.
    h.db.update(t.person).set({ adminSince: MONTH_AGO }).where(eq(t.person.id, 'p_robin')).run();
    h.db.update(t.passkey).set({ createdAt: hoursAgo(24) }).where(eq(t.passkey.personId, 'p_robin')).run();
    expect((await reset(h, 'p_robin', 'p_sam')).json()).toMatchObject({ approvedBy: null });
    h.db.update(t.passkey).set({ createdAt: MONTH_AGO }).where(eq(t.passkey.personId, 'p_robin')).run();
    expect((await reset(h, 'p_robin', 'p_sam')).json()).toMatchObject({ approvedBy: { id: 'p_robin' }, waitsFor: 'an_hour' });
    expect(audit(h.db)[0]).toEqual(['p_alex', 'role_changed', 'p_robin']);
  });

  it('an ask whose asker was removed is nobody\'s: the next admin\'s call asks again, a day from then', async () => {
    const h = await start();
    h.db.insert(t.person).values({ id: 'p_quinn', name: 'Quinn', role: 'admin', createdAt: MONTH_AGO, adminSince: MONTH_AGO }).run();
    h.db.insert(t.passkey).values({ id: 'pk-p_quinn', personId: 'p_quinn', publicKey: Buffer.from([1]), label: 'x', createdAt: MONTH_AGO }).run();
    await reset(h, 'p_quinn', 'p_sam');
    expect((await h.send('DELETE', '/api/people/p_quinn', h.fresh('p_alex'))).statusCode).toBe(204);
    const r = (await reset(h, 'p_alex', 'p_sam')).json();
    expect(r).toMatchObject({ state: 'asked', waitsFor: 'a_day', askedBy: { id: 'p_alex' }, approvedBy: null });
    expect(Date.parse(r.notBefore) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(passkeysOf(h, 'p_sam')).toHaveLength(1);
    expect(audit(h.db).map((a) => a[1])).toEqual(['reset_asked', 'reset_cancelled', 'reset_asked']);
  });

  it('a kid\'s reset is told to their parents when it is asked; with none set, to the admins', async () => {
    const h = await start();
    await reset(h, 'p_alex', 'p_mia');
    expect(await notices(h, 'p_sam')).toContainEqual(['reset_asked', 'p_mia', 'p_alex']);
    await reset(h, 'p_alex', 'p_leo');
    expect(await notices(h, 'p_robin')).not.toContainEqual(['reset_asked', 'p_leo', 'p_alex']);
  });
});
