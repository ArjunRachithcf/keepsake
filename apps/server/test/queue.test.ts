// The push queue's lifecycle (PR #12 third review, L1–L4): stopping for good and quickly, a failing pending row that
// blocks nothing, the pending row in the change's own transaction, and the pushes a stop could not send kept for the
// next start.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import * as t from '../src/db/schema';
import { MAX_ATTEMPTS, Pusher, SET_ASIDE_DAYS, STOP_WAIT_MS, THROTTLE_DROP_MS, type Subscription } from '../src/push/push';
import { standalone } from './helpers';
import { as, makeHome, ok, pin, type Home } from './m4';

const T0 = new Date('2026-12-01T10:00:00.000Z');
const BATCH = new Date('2026-12-02T08:00:00.000Z');
const ON = { KEEPSAKE_EGRESS: 'on' };
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async (...a: Parameters<typeof makeHome>) => { const h = await makeHome(...a); homes.push(h); return h; };
afterEach(async () => { vi.setSystemTime(T0); for (const h of homes.splice(0)) await h.built.app.close(); });

/** Quinn asks Robin, the batch delivers it; returns the question's id. */
async function asked(h: Home): Promise<string> {
  const q = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'Which size?' }))).json().id as string;
  vi.setSystemTime(BATCH);
  h.built.morning(BATCH);
  await h.built.pusher.idle();
  return q;
}

describe('the push queue', () => {
  it('stop() arms no tick after it, and does not wait on a hung push service beyond STOP_WAIT_MS (L1)', async () => {
    const h = await home(ON);
    let release!: () => void;
    const hung = new Promise<number>((done) => { release = () => done(201); });
    let calls = 0;
    const p = new Pusher(h.db, async () => { calls++; return hung; }, { tickMs: 1, jitterMs: 0 });
    p.wake(['p_robin']);
    p.start();
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2000, interval: 5 });
    const at = performance.now();
    await p.stop();
    expect(performance.now() - at).toBeLessThan(STOP_WAIT_MS + 1000);
    // A tick after stop() would make this row into its notice.
    p.tell({ kind: 'draw', subjectId: 'c_after', day: '2026-12-01', people: ['p_robin'] });
    release();
    await new Promise((done) => setTimeout(done, 100));
    expect([calls, h.db.select().from(t.pendingNotice).all().map((r) => r.subjectId)]).toEqual([1, ['c_after']]);
  }, 10_000);

  it('a pending row that fails is reported without its content, tried again later, set aside after MAX_ATTEMPTS, and never blocks the others (L2)', async () => {
    const h = await home(ON);
    const warned: unknown[] = [];
    const p = new Pusher(h.db, async () => 201, { warn: (m, f) => warned.push([m, f]) });
    p.resolve('answered', () => { throw new Error('q_secret is broken'); });
    p.tell({ kind: 'answered', subjectId: 'q_secret', day: '2026-12-01' });
    p.tell({ kind: 'draw', subjectId: 'c_one', day: '2026-12-01', people: ['p_robin'] });
    await p.idle();
    const notices = h.db.select().from(t.notice).where(eq(t.notice.subjectId, 'c_one')).all().map((n) => n.personId);
    const bad = () => h.db.select().from(t.pendingNotice).all();
    expect([notices, bad().map((r) => [r.subjectId, r.attempts])]).toEqual([['p_robin'], [['q_secret', 1]]]);
    expect(JSON.stringify(warned)).not.toMatch(/q_secret|p_robin|broken/);
    // Tried again once due, until set aside; idle() never spins on it.
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      h.db.update(t.pendingNotice).set({ nextAt: null }).run();
      await p.idle();
    }
    expect(bad().map((r) => r.attempts)).toEqual([MAX_ATTEMPTS]);
    expect(warned).toHaveLength(MAX_ATTEMPTS);
  });

  it('the pending row is written in the change\'s own transaction: if it cannot be, the change is undone (L3)', async () => {
    const h = await home(ON);
    const q = await asked(h);
    h.built.pusher.tell = () => { throw new Error('the disk is full'); };
    expect((await as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'M' })).statusCode).toBe(500);
    expect(h.db.select().from(t.question).where(eq(t.question.id, q)).get()!.state).toBe('open');
  });

  it('the notices a stop makes keep their push pending in the database; the next start sends it (L4)', async () => {
    const h = await makeHome(ON);
    const q = await asked(h);
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/answer`, { text: 'M' }));
    await h.built.app.close();
    expect(h.db.select().from(t.pendingPush).all().map((r) => r.personId)).toEqual(['p_quinn']);
    const sent: Subscription[] = [];
    const next = await buildApp(standalone(ON), h.db, { pushTransport: async (s) => { sent.push(s); return 201; } });
    try {
      await next.pusher.tick();
      expect([sent.map((s) => s.personId), h.db.select().from(t.pendingPush).all()]).toEqual([['p_quinn'], []]);
    } finally { await next.app.close(); }
  });

  it('a row set aside is pruned SET_ASIDE_DAYS after its last try, with the people it names; one still tried is not (issue #13, 3)', async () => {
    const h = await home(ON);
    const p = new Pusher(h.db, async () => 201);
    p.resolve('answered', () => { throw new Error('broken'); });
    p.tell({ kind: 'answered', subjectId: 'q_aside', day: '2026-12-01' });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      h.db.update(t.pendingNotice).set({ nextAt: null }).run();
      await p.idle();
    }
    p.tell({ kind: 'answered', subjectId: 'q_waiting', day: '2026-12-01' });
    await p.idle();
    const rows = () => h.db.select().from(t.pendingNotice).all().map((r) => [r.subjectId, r.attempts]);
    expect(rows()).toEqual([['q_aside', MAX_ATTEMPTS], ['q_waiting', 1]]);
    // Its last try's retry time is an hour after T0 at most: just before the retention, it stays.
    vi.setSystemTime(new Date(T0.getTime() + SET_ASIDE_DAYS * 86_400_000));
    await p.tick();
    expect(rows().map((r) => r[0])).toEqual(['q_aside', 'q_waiting']);
    vi.setSystemTime(new Date(T0.getTime() + (SET_ASIDE_DAYS + 1) * 86_400_000));
    await p.tick();
    expect(rows()).toEqual([['q_waiting', 3]]);
  });

  /** Alex, Robin and Sam each have one device, in that order; Robin's push service hangs until released. */
  function threeDevices(h: Home) {
    h.db.delete(t.pushSubscription).run();
    for (const p of ['p_alex', 'p_robin', 'p_sam']) {
      h.db.insert(t.pushSubscription).values({ id: `ps_${p}`, personId: p, endpoint: `https://fcm.googleapis.com/fcm/send/${p}`, p256dh: 'x', auth: 'x', createdAt: T0.toISOString(), confirmedAt: T0.toISOString() }).run();
    }
    let release!: () => void;
    const hung = new Promise<number>((done) => { release = () => done(201); });
    const calls: string[] = [];
    const transport = async (s: Subscription) => { calls.push(s.personId); return s.personId === 'p_robin' ? hung : 201; };
    return { release, calls, transport };
  }
  const pendingPushes = (h: Home) => h.db.select().from(t.pendingPush).all().map((r) => r.personId).sort();

  it('a stop while a push is being sent keeps it, and everyone not reached yet, pending; whoever was reached is done (issue #13, 1)', async () => {
    const h = await home(ON);
    const { release, calls, transport } = threeDevices(h);
    const p = new Pusher(h.db, transport);
    p.wake(['p_alex', 'p_robin', 'p_sam']);
    void p.tick();
    await vi.waitFor(() => expect(calls).toEqual(['p_alex', 'p_robin']), { timeout: 2000, interval: 5 });
    await p.stop();
    expect(pendingPushes(h)).toEqual(['p_robin', 'p_sam']);
    // The push that was hung ends after the stop: nothing more is sent or changed.
    release();
    await new Promise((done) => setTimeout(done, 50));
    expect([calls, pendingPushes(h)]).toEqual([['p_alex', 'p_robin'], ['p_robin', 'p_sam']]);
  }, 10_000);

  it('a crash in the middle of sending, or after a 429, loses no push: the next start sends them (issue #13, 4)', async () => {
    const h = await home(ON);
    const { calls, transport } = threeDevices(h);
    const crashed = new Pusher(h.db, transport);
    crashed.wake(['p_alex', 'p_robin', 'p_sam']);
    void crashed.tick();
    await vi.waitFor(() => expect(calls).toEqual(['p_alex', 'p_robin']), { timeout: 2000, interval: 5 });
    // The process dies here: no stop(). The next one sends what was not sent; Robin's service answers 429 now.
    const sent: string[] = [];
    let status = (_p: string) => (_p === 'p_robin' ? 429 : 201);
    const next = new Pusher(h.db, async (s) => { sent.push(s.personId); return status(s.personId); });
    await next.tick();
    // Alex was reached before the crash; Robin's push was on its way, Sam's not sent yet.
    expect([sent, pendingPushes(h)]).toEqual([['p_robin'], ['p_robin', 'p_sam']]);
    // What the 429 held back is still in the database: another crash loses nothing either.
    status = () => 201;
    sent.length = 0;
    const third = new Pusher(h.db, async (s) => { sent.push(s.personId); return status(s.personId); });
    await third.idle();
    expect([sent, pendingPushes(h)]).toEqual([['p_robin', 'p_sam'], []]);
  });

  it('news for someone while their push is being sent is pushed again after it', async () => {
    const h = await home(ON);
    const { release, calls, transport } = threeDevices(h);
    const p = new Pusher(h.db, transport);
    p.wake(['p_alex', 'p_robin', 'p_sam']);
    const first = p.tick();
    await vi.waitFor(() => expect(calls).toEqual(['p_alex', 'p_robin']), { timeout: 2000, interval: 5 });
    p.wake(['p_alex']);
    release();
    await first;
    expect(pendingPushes(h)).toEqual(['p_alex']);
    await p.idle();
    expect([calls, pendingPushes(h)]).toEqual([['p_alex', 'p_robin', 'p_sam', 'p_alex'], []]);
  });

  /** Robin's devices: one on Mozilla's push service, one on Google's. */
  function robinTwoServices(h: Home) {
    h.db.delete(t.pushSubscription).run();
    for (const [id, host] of [['moz', 'updates.push.services.mozilla.com'], ['fcm', 'fcm.googleapis.com']] as const) {
      h.db.insert(t.pushSubscription).values({ id, personId: 'p_robin', endpoint: `https://${host}/wpush/v2/${id}`, p256dh: 'x', auth: 'x', createdAt: T0.toISOString(), confirmedAt: T0.toISOString() }).run();
    }
  }

  it('news for someone while their own push is on its way gets a push of its own (PR #14 review, probe W)', async () => {
    const h = await home(ON);
    const { release, calls, transport } = threeDevices(h);
    const p = new Pusher(h.db, transport);
    p.wake(['p_robin']);
    const first = p.tick();
    await vi.waitFor(() => expect(calls).toEqual(['p_robin']), { timeout: 2000, interval: 5 });
    p.wake(['p_robin']);
    release();
    await first;
    expect(pendingPushes(h)).toEqual(['p_robin']);
    await p.idle();
    expect([calls, pendingPushes(h)]).toEqual([['p_robin', 'p_robin'], []]);
  });

  it('a device reached before a 429 on another of its person\'s devices is not pushed again (PR #14 review, probe R)', async () => {
    const h = await home(ON);
    robinTwoServices(h);
    const sent: string[] = [];
    let fcm = 429;
    const p = new Pusher(h.db, async (s) => { sent.push(s.id); return s.id === 'fcm' ? fcm : 201; });
    p.wake(['p_robin']);
    await p.tick();
    fcm = 201;
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await p.tick();
    expect([sent, pendingPushes(h)]).toEqual([['moz', 'fcm', 'fcm'], []]);
  });

  it('a push service answering 429 is backed off 1, 2, 4 … minutes, and after a day its pushes are dropped (PR #14 review, 2)', async () => {
    const h = await home(ON);
    robinTwoServices(h);
    const sent: string[] = [];
    const p = new Pusher(h.db, async (s) => { sent.push(s.id); return s.id === 'fcm' ? 429 : 201; });
    const at = async (ms: number) => { vi.setSystemTime(new Date(T0.getTime() + ms)); sent.length = 0; await p.tick(); return [...sent]; };
    p.wake(['p_robin']);
    expect(await at(0)).toEqual(['moz', 'fcm']);
    // Within its minute of backoff it is not called at all; after it, once; then two minutes.
    expect(await at(30_000)).toEqual([]);
    expect(await at(61_000)).toEqual(['fcm']);
    expect(await at(61_000 + 90_000)).toEqual([]);
    expect(await at(61_000 + 121_000)).toEqual(['fcm']);
    expect(pendingPushes(h)).toEqual(['p_robin']);
    // A day after its first 429 the pushes waiting for it are dropped (the notices stay in the app).
    expect(await at(THROTTLE_DROP_MS + 1)).toEqual([]);
    expect(pendingPushes(h)).toEqual([]);
  });
});
