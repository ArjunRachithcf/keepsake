// Notices, Web Push, reminders and thank-yous (ADR 0010) on the raw responses. What is new for someone comes only
// from what they may know; a push says "Something new" and nothing else, to known push services only, after the
// answer; the morning batch tells everyone at 08:00, once; "Remind me" is its owner's alone; a thank-you reaches the
// givers, and its writer's answers are byte for byte the same whoever gave. Fictional names only; nothing leaves.
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as t from '../src/db/schema';
import type { Egress } from '../src/net/egress';
import { noticeId } from '../src/notices/notices';
import { refreshRevealed } from '../src/gifts/gifts';
import { ORIGIN, TEST_P256DH, TEST_VAPID, sessionCookie } from './helpers';
import { GUESTS, PEOPLE, as, makeHome, ok, pin, reads, setNow, type Guest, type Home, type Who } from './m4';
import { vapidFrom } from '../src/push/webpush';
import { subscribe } from '../src/push/push';
import { buildApp } from '../src/app';
import { standalone } from './helpers';

const T0 = new Date('2026-12-01T10:00:00.000Z');
const BATCH = new Date('2026-12-02T08:00:00.000Z');
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async (...a: Parameters<typeof makeHome>) => { const h = await makeHome(...a); homes.push(h); return h; };
afterEach(async () => { setNow(T0); for (const h of homes.splice(0)) await h.built.app.close(); });

const notices = async (h: Home, who: Who) => (await h.built.pusher.idle(), await ok(as(h, who).get('/api/notices'))).json() as { notices: { kind: string; person: { id: string } | null; celebration: { id: string } | null; question: string | null; read: boolean; on: string }[]; unread: number };
const kinds = async (h: Home, who: Who) => (await notices(h, who)).notices.map((n) => n.kind);
const pushed = async (h: Home, who: Who) => { await h.built.pusher.idle(); return h.pushes.get(`p_${who}`) ?? 0; };
/** Time travel: the clock moves on, the household signs in again (a session lasts 30 days, 7 idle). */
const travel = (h: Home, at: Date) => { setNow(at); for (const p of PEOPLE) h.cookies[p] = sessionCookie(h.db, `p_${p}`); };
const morning = async (h: Home, at: Date) => { travel(h, at); h.built.morning(at); await h.built.pusher.idle(); };
const ALL: (Who | Guest)[] = [...PEOPLE, ...(Object.keys(GUESTS) as Guest[])];
const ON = { KEEPSAKE_EGRESS: 'on' };
const SUB = (device: string, p256dh = TEST_P256DH) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, keys: { p256dh, auth: Buffer.alloc(16, 3).toString('base64url') } });

describe('a device subscribes for its person, to a known push service only', () => {
  it('GET /push gives the public key; egress off: no push, and subscribing is refused', async () => {
    const h = await home(ON);
    expect((await as(h, 'robin').get('/api/push')).json()).toEqual({ available: true, publicKey: vapidFrom(Buffer.from(TEST_VAPID, 'base64url')).publicKey.toString('base64url') });
    const off = await home();
    expect((await as(off, 'robin').get('/api/push')).json()).toEqual({ available: false, publicKey: null });
    expect((await as(off, 'robin').send('PUT', '/api/push/subscription', SUB('d1'))).json()).toEqual({ error: 'push is off on this server' });
  });

  it.each([
    ['another host', { endpoint: 'https://evil.example/fcm/send/x' }], ['http', { endpoint: 'http://fcm.googleapis.com/fcm/send/x' }],
    ['a port', { endpoint: 'https://fcm.googleapis.com:8443/x' }], ['an address', { endpoint: 'https://10.0.0.1/x' }],
    ['the household\'s edge', { endpoint: 'https://keepsake.home.arpa/api/notices' }], ['credentials', { endpoint: 'https://u:p@fcm.googleapis.com/x' }],
    ['not a key', { keys: { p256dh: 'A'.repeat(87), auth: Buffer.alloc(16).toString('base64url') } }],
    ['a short auth', { keys: { p256dh: TEST_P256DH, auth: Buffer.alloc(8).toString('base64url') } }],
    ['an extra field', { extra: 1 }],
  ])('refused: %s', async (_n, change) => {
    const h = await home(ON);
    const r = await as(h, 'robin').send('PUT', '/api/push/subscription', { ...SUB('d1'), ...change });
    expect(r.statusCode, r.body).toBe(400);
    expect(h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_robin')).all()).toHaveLength(1); // only the test's own
  });

  it('ten devices a person (the oldest go); unsubscribing another\'s endpoint changes nothing; a session\'s device goes with it', async () => {
    const h = await home(ON);
    const robin = () => h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_robin')).all();
    for (let i = 0; i < 11; i++) { setNow(new Date(T0.getTime() + i * 1000)); await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB(`r${i}`))); }
    expect(robin()).toHaveLength(10);
    expect(robin().map((s) => s.endpoint)).not.toContain('https://fcm.googleapis.com/fcm/send/r0');
    await ok(as(h, 'sam').send('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/r5' }));
    expect(robin()).toHaveLength(10);
    // Signing out on this browser ends its session, and its devices' subscriptions with it.
    await ok(as(h, 'robin').send('POST', '/api/auth/sign-out'));
    expect(robin().filter((s) => s.sessionId !== null)).toEqual([]);
  });
});

describe('a push says nothing', () => {
  it('the same encrypted message to the push service, whatever happened; the browser reads only {"v":1}', async () => {
    const sent: { url: string; rules: string; headers: Record<string, string>; body: Buffer }[] = [];
    const egress: Egress = { request: async (url, rules, _want, req) => { sent.push({ url, rules: rules.name, headers: req?.headers ?? {}, body: req?.body ?? Buffer.alloc(0) }); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
    const h = await home(ON, { egress, pushTransport: undefined });
    h.db.delete(t.pushSubscription).run();
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('robin')));
    await ok(as(h, 'quinn').send('PUT', '/api/push/subscription', SUB('quinn')));
    // A question for Robin (at the batch), then Robin's answer (to Quinn, who asked): two different things.
    const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Leather or wool gloves?' }))).json().id;
    await morning(h, BATCH);
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'Wool, please' }));
    await h.built.pusher.idle();
    expect(sent.map((s) => [s.url, s.rules])).toEqual([['https://fcm.googleapis.com/fcm/send/robin', 'push service'], ['https://fcm.googleapis.com/fcm/send/quinn', 'push service']]);
    expect(new Set(sent.map((s) => s.body.length)).size).toBe(1);
    for (const s of sent) {
      expect(Object.keys(s.headers).sort()).toEqual(['authorization', 'content-encoding', 'content-type', 'topic', 'ttl', 'urgency']);
      expect(s.headers).toMatchObject({ 'content-encoding': 'aes128gcm', topic: 'keepsake', ttl: '86400' });
      // What the browser decrypts (the test's subscription key is made from a known scalar).
      const salt = s.body.subarray(0, 16);
      const asPublic = s.body.subarray(21, 86);
      const ua = createECDH('prime256v1'); ua.setPrivateKey(Buffer.alloc(32, 5));
      const hmac = (k: Buffer, ...x: Buffer[]) => { const m = createHmac('sha256', k); for (const y of x) m.update(y); return m.digest(); };
      const prk = hmac(salt, hmac(hmac(Buffer.alloc(16, 3), ua.computeSecret(asPublic)), Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])));
      const d = createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12));
      const body = s.body.subarray(86);
      d.setAuthTag(body.subarray(body.length - 16));
      const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
      expect(plain.subarray(0, plain.indexOf(2)).toString()).toBe('{"v":1}');
    }
  });

  it('a push leaves after the answer: a push service that never answers holds up nothing', async () => {
    const h = await home(ON, { pushTransport: () => new Promise(() => {}) });
    const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Which size?' }))).json().id;
    setNow(BATCH);
    h.built.morning(BATCH);
    const r = await as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'M' });
    expect(r.statusCode).toBe(204);
  });

  it('what a push service answers (PR #12 review, L4): 404 and 410 drop; 429 holds that service back for the tick; 5xx and our own failures never drop; another 4xx drops only after 3 days', async () => {
    let status = 410;
    const sent: string[] = [];
    const h = await home(ON, { pushTransport: async (s) => { sent.push(s.id); return status; } });
    const subs = () => h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_robin')).all();
    const push = async () => { h.built.pusher.wake(['p_robin']); await h.built.pusher.idle(); };
    await push();
    expect(subs()).toEqual([]);
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('r1')));
    for (const s of [500, 503, 0, 429]) { status = s; for (let i = 0; i < 10; i++) await push(); }
    expect(subs()).toHaveLength(1);
    // A 429: the service's other pushes in that tick wait for the next one, and are sent then.
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('r2')));
    sent.length = 0;
    await push();
    expect(sent).toHaveLength(1);
    status = 201;
    await h.built.pusher.tick();
    expect(sent).toHaveLength(3);
    status = 403;
    await push();
    expect(subs().every((s) => s.failingSince !== null)).toBe(true);
    setNow(new Date(T0.getTime() + 2 * 86_400_000));
    await push();
    expect(subs()).toHaveLength(2);
    setNow(new Date(T0.getTime() + 3 * 86_400_000 + 60_000));
    await push();
    expect(subs()).toEqual([]);
  });

  it('a subscription its device has not sent again for 30 days goes; sending it again confirms it (PR #12 review, N4, M2)', async () => {
    // Behind HomersLab a subscription has no session to end with: only its confirmation keeps it.
    const h = await home(ON);
    const robin = () => h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_robin')).all();
    const push = async (day: number) => { setNow(new Date(T0.getTime() + day * 86_400_000)); h.built.pusher.wake(['p_robin']); await h.built.pusher.idle(); };
    const r = { endpoint: SUB('r').endpoint, ...SUB('r').keys };
    subscribe(h.db, 'p_robin', null, r, T0);
    await push(20);
    subscribe(h.db, 'p_robin', null, r, new Date(T0.getTime() + 20 * 86_400_000));
    await push(45);
    expect(robin().map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/r']);
    await push(51);
    expect(robin()).toEqual([]);
  });

  it('a session that ended idle took its device\'s subscription; the next start of the app sends it again and pushes come again (PR #12 review, M2)', async () => {
    const h = await home(ON);
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('r')));
    const robin = () => h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_robin')).all().filter((s) => s.sessionId);
    travel(h, new Date(T0.getTime() + 8 * 86_400_000));
    h.built.pusher.wake(['p_robin']); await h.built.pusher.idle();
    expect(robin()).toEqual([]);
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('r')));
    expect(robin()).toHaveLength(1);
  });

  it('the request that causes a notice makes none and sends nothing: the queue does, on its tick (PR #12 review, L6)', async () => {
    const calls: string[] = [];
    const h = await home(ON, { pushTransport: async (s) => { calls.push(s.personId); return 201; } });
    const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Which size?' }))).json().id;
    await morning(h, BATCH);
    calls.length = 0;
    const count = () => h.db.select().from(t.notice).all().length;
    const before = count();
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'M' }));
    await new Promise((ok) => setTimeout(ok, 50));
    expect([count(), calls]).toEqual([before, []]);
    await h.built.pusher.tick();
    expect([count(), calls]).toEqual([before + 1, ['p_quinn']]);
  });

  it('the app\'s own re-sending (sync) never moves a device from one person to another; the switch does (PR #12 second review, N-M2)', async () => {
    const h = await home(ON);
    const owner = () => h.db.select().from(t.pushSubscription).all().filter((s) => /\/(shared|mine)$/.test(s.endpoint)).map((s) => s.personId);
    await ok(as(h, 'quinn').send('PUT', '/api/push/subscription', SUB('shared')));
    const synced = await as(h, 'robin').send('PUT', '/api/push/subscription', { ...SUB('shared'), sync: true });
    expect([synced.statusCode, owner()]).toEqual([204, ['p_quinn']]);
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', { ...SUB('mine'), sync: true }));
    expect(owner().sort()).toEqual(['p_quinn', 'p_robin']);
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('shared')));
    expect(owner()).toEqual(['p_robin', 'p_robin']);
    expect((await as(h, 'robin').send('PUT', '/api/push/subscription', { ...SUB('x'), sync: 'yes' })).statusCode).toBe(400);
  });

  it('sent again with the same keys, a subscription keeps since when it fails and when it was made (PR #12 second review)', async () => {
    const h = await home(ON, { pushTransport: async () => 403 });
    const robin = () => h.db.select().from(t.pushSubscription).where(eq(t.pushSubscription.endpoint, 'https://fcm.googleapis.com/fcm/send/r')).get()!;
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', SUB('r')));
    h.built.pusher.wake(['p_robin']); await h.built.pusher.idle();
    const first = robin();
    expect(first.failingSince).not.toBeNull();
    setNow(new Date(T0.getTime() + 60_000));
    await ok(as(h, 'robin').send('PUT', '/api/push/subscription', { ...SUB('r'), sync: true }));
    expect(robin()).toMatchObject({ failingSince: first.failingSince, createdAt: first.createdAt, confirmedAt: new Date(T0.getTime() + 60_000).toISOString() });
  });

  describe('the queue is durable: a stop or a crash before the tick loses nothing (PR #12 second review, N-M1)', () => {
    const answered = async () => {
      const h = await makeHome(ON);
      const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Which size?' }))).json().id;
      travel(h, BATCH); h.built.morning(BATCH); await h.built.pusher.idle();
      await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'M' }));
      const told = () => h.db.select().from(t.notice).where(eq(t.notice.kind, 'answered')).all().map((n) => n.personId);
      expect([told(), h.db.select().from(t.pendingNotice).all().length]).toEqual([[], 1]);
      return { h, told };
    };

    it('a stop (SIGTERM: app.close) makes what is pending into its notices first', async () => {
      const { h, told } = await answered();
      await h.built.app.close();
      expect([told(), h.db.select().from(t.pendingNotice).all()]).toEqual([['p_quinn'], []]);
    });

    it('after a crash, the next start makes them', async () => {
      const { h, told } = await answered();
      // The process dies: no close, the queue's memory is gone; the database stays.
      const next = await buildApp(standalone(ON), h.db, { pushTransport: async () => 201 });
      try {
        await next.pusher.tick();
        expect([told(), h.db.select().from(t.pendingNotice).all()]).toEqual([['p_quinn'], []]);
      } finally { await next.app.close(); await h.built.app.close(); }
    });

  });
});

describe('the morning batch', () => {
  it('a question reaches its person at 08:00, not a moment before; a kid\'s goes to the kid\'s parents (the admins when none is set); once', async () => {
    const h = await home();
    const ask = async (p: string) => (await ok(as(h, 'quinn').send('POST', `/api/people/${p}/questions`, { text: 'Which colour?' }))).json().id as string;
    const [qr, qm, ql] = [await ask('p_robin'), await ask('p_mia'), await ask('p_leo')];
    await morning(h, T0);
    await morning(h, new Date(BATCH.getTime() - 1));
    for (const who of PEOPLE) expect(await kinds(h, who), who).toEqual([]);
    await morning(h, BATCH);
    expect((await notices(h, 'robin')).notices).toEqual([{ id: noticeId('p_robin', 'question', qr, '2026-12-02'), kind: 'question', on: '2026-12-02', read: false, celebration: null, person: { id: 'p_robin', name: 'Robin' }, question: qr }]);
    expect((await notices(h, 'sam')).notices.map((n) => n.question)).toEqual([qm]);
    expect((await notices(h, 'alex')).notices.map((n) => n.question)).toEqual([ql]);
    for (const who of ['mia', 'leo', 'quinn', 'uma'] as const) expect(await kinds(h, who), who).toEqual([]);
    const before = Object.fromEntries(await Promise.all(PEOPLE.map(async (p) => [p, await pushed(h, p)])));
    expect(before).toMatchObject({ robin: 1, sam: 1, alex: 1, mia: 0, leo: 0, quinn: 0 });
    // Again (a restart, the next tick): nothing new, no push.
    await morning(h, new Date(BATCH.getTime() + 3_600_000));
    for (const p of PEOPLE) expect(await pushed(h, p), p).toBe(before[p]);
    // Read: the count goes; an answered question's notice stays; a question an admin removed is gone from it.
    await ok(as(h, 'robin').send('POST', '/api/notices/read'));
    expect(await notices(h, 'robin')).toMatchObject({ unread: 0, notices: [{ read: true }] });
    await ok(as(h, 'alex').send('DELETE', `/api/questions/${qr}`));
    expect(await kinds(h, 'robin')).toEqual([]);
  });

  it('a celebration a week away: its people; "Remind me": whoever asked, the days they chose, about whom', async () => {
    const h = await home();
    await ok(as(h, 'quinn').send('PUT', '/api/people/p_mia/reminder', { days: 3 }));
    await ok(as(h, 'uma').send('PUT', '/api/people/p_sam/reminder', { days: 7 }));
    await morning(h, new Date('2026-12-16T08:00:00.000Z'));
    for (const who of PEOPLE) expect(await kinds(h, who), who).toEqual([]);
    await morning(h, new Date('2026-12-17T08:00:00.000Z'));
    for (const who of ['alex', 'sam', 'robin', 'mia', 'leo'] as const) expect((await notices(h, who)).notices, who).toMatchObject([{ kind: 'remind', celebration: { id: 'c_xmas' }, person: null, on: '2026-12-24' }]);
    expect((await notices(h, 'uma')).notices).toMatchObject([{ kind: 'remind', celebration: { id: 'c_xmas' }, person: { id: 'p_sam' } }]);
    expect(await kinds(h, 'quinn')).toEqual([]);
    await morning(h, new Date('2027-03-11T08:00:00.000Z'));
    expect((await notices(h, 'quinn')).notices).toMatchObject([{ kind: 'remind', celebration: { id: 'c_mia' }, person: { id: 'p_mia', name: 'Mia' }, on: '2027-03-14' }]);
    expect((await notices(h, 'mia')).notices.map((n) => n.kind)).toEqual(['remind']); // only Christmas
  });

  it('a draw\'s reveal date: its people and its host; nobody else', async () => {
    const h = await home();
    h.db.insert(t.draw).values({ id: 'd_x', celebrationId: 'c_xmas', year: 2026, rulesVersion: 1, revealOn: '2026-12-25', drawnAt: T0.toISOString(), occasionOn: '2026-12-24', createdBy: 'p_sam', createdAt: T0.toISOString(), updatedAt: T0.toISOString() }).run();
    for (const p of ['sam', 'robin', 'mia', 'quinn']) h.db.insert(t.drawParticipant).values({ id: `dp_${p}`, drawId: 'd_x', kind: 'person', personId: `p_${p}`, createdAt: T0.toISOString() }).run();
    await morning(h, new Date('2026-12-24T08:00:00.000Z'));
    expect((await kinds(h, 'robin')).filter((k) => k === 'reveal')).toEqual([]);
    await morning(h, new Date('2026-12-25T08:00:00.000Z'));
    const told = [];
    for (const who of PEOPLE) if ((await kinds(h, who)).includes('reveal')) told.push(who);
    expect(told.sort()).toEqual(['alex', 'mia', 'quinn', 'robin', 'sam']); // Alex hosts Christmas
  });
});

describe('a draw drawn, drawn again or cleared tells its people', () => {
  it('everyone in it but whoever drew; a re-draw tells them again', async () => {
    const h = await home();
    await ok(as(h, 'alex').send('POST', '/api/celebrations/c_xmas/draw', { people: ['p_alex', 'p_sam', 'p_robin', 'p_mia'], kidsDraw: true }));
    for (const who of PEOPLE) expect(await kinds(h, who), who).toEqual([]);
    await ok(as(h, 'alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    for (const who of PEOPLE) expect((await kinds(h, who)).includes('draw'), who).toBe(['sam', 'robin', 'mia'].includes(who));
    expect(await pushed(h, 'sam')).toBe(1);
    await ok(as(h, 'sam').send('POST', '/api/notices/read'));
    setNow(new Date(T0.getTime() + 60_000));
    await ok(as(h, 'alex').send('POST', '/api/celebrations/c_xmas/draw/run'));
    expect(await notices(h, 'sam')).toMatchObject({ unread: 1, notices: [{ kind: 'draw', celebration: { id: 'c_xmas' } }] });
    expect(await pushed(h, 'sam')).toBe(2);
  });
});

describe('an answer tells its asker, and nobody else', () => {
  it('a grown-up asker is told; a guest asker has no notices; the person, the host and admins are told nothing', async () => {
    const h = await home();
    const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Leather or wool?' }))).json().id;
    const g = (await ok(as(h, 'gR').send('POST', '/api/guest/questions', { text: 'Which size?' }))).json().id;
    await morning(h, BATCH);
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'Wool' }));
    await ok(as(h, 'robin').send('POST', `/api/questions/${g}/decline`));
    expect((await notices(h, 'quinn')).notices).toMatchObject([{ kind: 'answered', question: q, person: { id: 'p_robin' } }]);
    for (const who of ['alex', 'sam', 'mia', 'leo', 'uma'] as const) expect(await kinds(h, who), who).toEqual([]);
    expect(await kinds(h, 'robin')).toEqual(['question', 'question']);
  });

  it('who asked changes nobody else\'s notices or pushes (twin households)', async () => {
    const [a, b] = [await home(), await home()];
    const qa = (await ok(as(a, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Leather or wool?' }))).json().id;
    const qb = (await ok(as(b, 'uma').send('POST', '/api/people/p_robin/questions', { text: 'Leather or wool?' }))).json().id;
    b.db.update(t.question).set({ id: qa }).where(eq(t.question.id, qb)).run();
    for (const h of [a, b]) { await morning(h, BATCH); await ok(as(h, 'robin').send('POST', `/api/questions/${qa}/answer`, { text: 'Wool' })); }
    for (const v of ALL.filter((x) => x !== 'quinn' && x !== 'uma')) expect(await reads(a, v), v).toEqual(await reads(b, v));
  }, 30_000);
});

describe('"Remind me" is its owner\'s alone', () => {
  it('only the one who set it sees it; never about oneself; everyone else\'s answers are as with none', async () => {
    const [a, none] = [await home(), await home()];
    await ok(as(a, 'quinn').send('PUT', '/api/people/p_mia/reminder', { days: 3 }));
    await ok(as(a, 'robin').send('PUT', '/api/people/p_mia/reminder', { days: 10 }));
    expect((await as(a, 'quinn').get('/api/people/p_mia')).json().reminder).toBe(3);
    expect((await as(a, 'robin').get('/api/people/p_mia')).json().reminder).toBe(10);
    expect((await as(a, 'mia').get('/api/people/p_mia')).json().reminder).toBeNull();
    expect((await as(a, 'mia').send('PUT', '/api/people/p_mia/reminder', { days: 3 })).statusCode).toBe(403);
    for (const bad of [0, 61, 1.5, '3']) expect((await as(a, 'quinn').send('PUT', '/api/people/p_mia/reminder', { days: bad })).statusCode, String(bad)).toBe(400);
    for (const at of [T0, new Date('2027-03-04T08:00:00.000Z'), new Date('2027-03-11T08:00:00.000Z')]) {
      for (const h of [a, none]) travel(h, at);
      // Guests' sessions end after 30 days unused: they are compared today only.
      const viewers = (at === T0 ? ALL : PEOPLE).filter((x) => x !== 'quinn' && x !== 'robin');
      for (const v of viewers) expect(await reads(a, v), `${at.toISOString()} ${v}`).toEqual(await reads(none, v));
    }
    await ok(as(a, 'quinn').send('PUT', '/api/people/p_mia/reminder', { days: null }));
    expect((await as(a, 'quinn').get('/api/people/p_mia')).json().reminder).toBeNull();
  }, 60_000);
});

describe('thank-yous never name a giver to someone who may not know', () => {
  /** An any-time wish of `person`'s, given last Christmas by `givers` (each one unit): its person has it. */
  function given(h: Home, person: string, givers: string[], quantity = givers.length) {
    h.db.insert(t.wish).values({ id: 'w_gift', personId: person, name: 'A blue mug', state: 'listed', quantity, position: 9, addedBy: person, createdAt: T0.toISOString(), updatedAt: T0.toISOString() }).run();
    givers.forEach((g, i) => h.db.insert(t.claim).values({ id: `cl_${i}`, wishId: 'w_gift', giverId: g, quantity: quantity / givers.length, state: 'given', givenOn: '2025-12-24', createdAt: T0.toISOString(), updatedAt: T0.toISOString() }).run());
    refreshRevealed(h.db, '2026-12-01');
  }
  const THANKS = { text: 'Thank you, I use it every morning' };

  it.each([
    { title: 'one giver: Quinn or Uma', a: ['p_quinn'], b: ['p_uma'] },
    { title: 'two givers or one', a: ['p_quinn', 'p_uma'], b: ['p_quinn'] },
  ])('the writer\'s answers are byte for byte the same: $title', async ({ a: ga, b: gb }) => {
    const [a, b] = [await home(), await home()];
    given(a, 'p_sam', ga, 2);
    given(b, 'p_sam', gb, 2);
    const viewers: (Who | Guest)[] = ['sam', 'mia', 'leo', 'robin', 'gR', 'gM'];
    for (const v of viewers) expect(await reads(a, v), `before: ${v}`).toEqual(await reads(b, v));
    const [ra, rb] = [await ok(as(a, 'sam').send('PUT', '/api/wishes/w_gift/thanks', THANKS)), await ok(as(b, 'sam').send('PUT', '/api/wishes/w_gift/thanks', THANKS))];
    expect(ra.body).toBe(rb.body);
    expect(ra.json()).toMatchObject({ wish: { id: 'w_gift' }, from: [], sent: { text: THANKS.text, on: '2026-12-01', by: { id: 'p_sam' } } });
    for (const v of viewers) expect(await reads(a, v), `after: ${v}`).toEqual(await reads(b, v));
    // Every giver reads it, named or not; nobody else.
    for (const [h, gs] of [[a, ga], [b, gb]] as const) {
      for (const who of ['quinn', 'uma'] as const) {
        const home = (await as(h, who).get('/api/home')).json();
        expect(home.thanked.length, who).toBe(gs.includes(`p_${who}`) ? 1 : 0);
        expect((await kinds(h, who)).includes('thanked'), who).toBe(gs.includes(`p_${who}`));
      }
      expect((await as(h, 'quinn').get('/api/home')).json().thanked[0] ?? null).toEqual(gs.includes('p_quinn') ? { id: expect.any(String), wish: { id: 'w_gift', name: 'A blue mug' }, from: { id: 'p_sam', name: 'Sam' }, by: null, text: THANKS.text, on: '2026-12-01' } : null);
    }
  }, 60_000);

  it('only for a gift its person has: before, the same 404 as for a wish with no gift; once only', async () => {
    const [a, none] = [await home(), await home()];
    a.db.insert(t.claim).values({ id: 'cl_t', wishId: 'w_sam_book', giverId: 'p_quinn', quantity: 1, state: 'given', givenOn: '2026-12-01', createdAt: T0.toISOString(), updatedAt: T0.toISOString() }).run();
    refreshRevealed(a.db, '2026-12-01');
    const [x, y] = [await as(a, 'sam').send('PUT', '/api/wishes/w_sam_book/thanks', THANKS), await as(none, 'sam').send('PUT', '/api/wishes/w_sam_book/thanks', THANKS)];
    expect([x.statusCode, x.body]).toEqual([404, y.body]);
    expect(await kinds(a, 'quinn')).toEqual([]);
    given(a, 'p_sam', ['p_quinn']);
    await ok(as(a, 'sam').send('PUT', '/api/wishes/w_gift/thanks', THANKS));
    expect((await as(a, 'sam').send('PUT', '/api/wishes/w_gift/thanks', THANKS)).statusCode).toBe(409);
    // A giver is not the person: theirs is a 404 too.
    expect((await as(a, 'quinn').send('PUT', '/api/wishes/w_gift/thanks', THANKS)).statusCode).toBe(404);
    for (const bad of [{ text: '' }, { text: 'x'.repeat(501) }, {}]) expect((await as(a, 'sam').send('PUT', '/api/wishes/w_gift/thanks', bad)).statusCode).toBe(400);
  });

  it('a kid\'s: a parent writes it with the kid; a parent who also gave is not told, the other givers are', async () => {
    const h = await home();
    given(h, 'p_mia', ['p_sam', 'p_quinn']);
    expect((await as(h, 'mia').get('/api/home')).json().thanks.map((x: { wish: { id: string } }) => x.wish.id)).toContain('w_gift');
    const r = await ok(as(h, 'sam').send('PUT', '/api/wishes/w_gift/thanks', THANKS));
    expect(r.json().sent).toEqual({ text: THANKS.text, on: '2026-12-01', by: { id: 'p_sam', name: 'Sam' } });
    expect((await as(h, 'mia').get('/api/home')).json().thanks.find((x: { wish: { id: string } }) => x.wish.id === 'w_gift').sent.by.name).toBe('Sam');
    expect((await as(h, 'quinn').get('/api/home')).json().thanked).toMatchObject([{ from: { name: 'Mia' }, by: { name: 'Sam' } }]);
    expect((await as(h, 'sam').get('/api/home')).json().thanked).toEqual([]);
    expect(await kinds(h, 'sam')).toEqual([]);
    expect((await as(h, 'mia').send('PUT', '/api/wishes/w_gift/thanks', THANKS)).statusCode).toBe(409);
  });

  it('the morning after: its person (a kid\'s parents too) is asked to say thank you; before, nobody', async () => {
    const h = await home();
    h.db.insert(t.claim).values({ id: 'cl_k', wishId: 'w_mia_bike', giverId: 'p_quinn', quantity: 1, state: 'given', givenOn: '2026-12-01', createdAt: T0.toISOString(), updatedAt: T0.toISOString() }).run();
    refreshRevealed(h.db, '2026-12-01');
    await morning(h, BATCH);
    for (const who of PEOPLE) expect((await kinds(h, who)).includes('say_thanks'), who).toBe(false);
    // Mia's birthday (14 March), the day after it: she has her bike.
    await morning(h, new Date('2027-03-15T08:00:00.000Z'));
    for (const who of PEOPLE) expect((await kinds(h, who)).includes('say_thanks'), who).toBe(['mia', 'sam'].includes(who));
  });
});

describe('notices on every route are the caller\'s own', () => {
  it('guests have none; a stranger is refused', async () => {
    const h = await home();
    expect((await as(h, 'gR').get('/api/notices')).statusCode).toBe(401);
    expect((await h.built.app.inject({ url: '/api/notices' })).statusCode).toBe(401);
    expect((await h.built.app.inject({ method: 'POST', url: '/api/notices/read', headers: { origin: ORIGIN } })).statusCode).toBe(401);
  });
});
