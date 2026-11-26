// Web Push (ADR 0010). A device subscribes with its browser's push service; when a person gets a notice, each of
// their devices is sent one push. Its payload is always the same few bytes, encrypted (`{"v":1}`): the service worker
// shows "Something new in Keepsake" and nothing else, and the app fetches what is new through the API, as the person.
// So a lock screen, a push service and a stolen subscription learn at most that something happened, never what.
//
// - An endpoint must be on a known push service (net/egress.ts PUSH_HOSTS), https, no port, no credentials: a
//   subscription cannot make Keepsake post to the household's network or anywhere else.
// - Pushes leave after the change that caused them, from a queue (`wake`), never inside the request: an answer's
//   timing never depends on push services.
// - The key (VAPID) is kept like the sealing key (push/keys.ts): outside the database and its backup.
// - A standalone subscription is the session's: it ends when that session ends (sign-out, a lost device).
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { tell, type NoticeKind } from '../notices/notices';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { allowed, EgressError, PUSH_HOSTS, type Egress } from '../net/egress';
import { pruneSessions } from '../auth/sessions';
import { encrypt, validClientKey, vapidAuthorization, type Vapid } from './webpush';

export type Subscription = typeof t.pushSubscription.$inferSelect;
export const MAX_DEVICES = 10;
/** The one message every push carries (ADR 0010). */
export const PAYLOAD = Buffer.from('{"v":1}');

export const subscriptionId = (endpoint: string) => createHash('sha256').update(`keepsake-push:${endpoint}`).digest('base64url').slice(0, 22);
const PUSH_RULES = { name: 'push service', hosts: PUSH_HOSTS };

/** A device's subscription as the browser gives it (PushSubscription.toJSON): checked before it is kept. */
export interface SubscriptionInput { endpoint: string; p256dh: string; auth: string }
export function checkSubscription(i: SubscriptionInput): SubscriptionInput {
  let u: URL;
  try { u = new URL(i.endpoint); } catch { throw new Refused(400, 'endpoint: a push service this Keepsake knows'); }
  if (i.endpoint.length > 1000 || !allowed(u, PUSH_RULES)) throw new Refused(400, 'endpoint: a push service this Keepsake knows');
  const key = Buffer.from(i.p256dh, 'base64url');
  const auth = Buffer.from(i.auth, 'base64url');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(i.p256dh) || !validClientKey(key) || !/^[A-Za-z0-9_-]{16,32}$/.test(i.auth) || auth.length !== 16) {
    throw new Refused(400, 'keys: the subscription\'s p256dh and auth');
  }
  return { endpoint: u.href, p256dh: i.p256dh, auth: i.auth };
}

/**
 * Keeps a device's subscription for the caller. Turning the switch on moves it to them if another person had it on that
 * device; the app's own re-sending (`sync`, PR #12 second review, N-M2) never does: it only confirms one that is the
 * caller's, or keeps a new one. Sent again with the same keys, it keeps when it was made and since when it fails.
 */
export function subscribe(db: Db, personId: string, sessionId: string | null, i: SubscriptionInput, now = new Date(), o: { sync?: boolean } = {}): void {
  const s = checkSubscription(i);
  const id = subscriptionId(s.endpoint);
  db.transaction((tx) => {
    const had = tx.select().from(t.pushSubscription).where(eq(t.pushSubscription.id, id)).get();
    if (had && had.personId !== personId && o.sync) return;
    if (had && had.personId === personId && had.p256dh === s.p256dh && had.auth === s.auth) {
      tx.update(t.pushSubscription).set({ sessionId, confirmedAt: now.toISOString() }).where(eq(t.pushSubscription.id, id)).run();
      return;
    }
    tx.delete(t.pushSubscription).where(eq(t.pushSubscription.id, id)).run();
    // Every PUT confirms it (the app sends it at every start and whenever it is shown, PR #12 review, M2, N4).
    tx.insert(t.pushSubscription).values({ id, personId, sessionId, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, createdAt: now.toISOString(), confirmedAt: now.toISOString() }).run();
    // The oldest go beyond MAX_DEVICES.
    const n = tx.select({ n: count() }).from(t.pushSubscription).where(eq(t.pushSubscription.personId, personId)).get()?.n ?? 0;
    if (n > MAX_DEVICES) {
      const old = tx.select({ id: t.pushSubscription.id }).from(t.pushSubscription).where(eq(t.pushSubscription.personId, personId))
        .orderBy(asc(t.pushSubscription.createdAt), asc(t.pushSubscription.id)).limit(n - MAX_DEVICES).all().map((r) => r.id);
      tx.delete(t.pushSubscription).where(inArray(t.pushSubscription.id, old)).run();
    }
  });
}

/** Ends a device's subscription: the caller's only (another's endpoint changes nothing, and says nothing). */
export function unsubscribe(db: Db, personId: string, endpoint: string): void {
  db.delete(t.pushSubscription).where(and(eq(t.pushSubscription.id, subscriptionId(endpoint)), eq(t.pushSubscription.personId, personId))).run();
}

/** What sends one push: the status the push service answered (production: through the egress client). */
export type Transport = (s: Subscription) => Promise<number>;

export function webPushTransport(egress: Egress, vapid: () => Vapid | null, subject: string): Transport {
  return async (s) => {
    const v = vapid();
    if (!v) return 0;
    const body = encrypt({ p256dh: Buffer.from(s.p256dh, 'base64url'), auth: Buffer.from(s.auth, 'base64url') }, PAYLOAD, { padTo: 32 });
    try {
      const r = await egress.request(s.endpoint, PUSH_RULES, 'push', {
        method: 'POST', body,
        headers: {
          authorization: vapidAuthorization(v, s.endpoint, subject), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
          // A day to live, and one topic: a push not yet delivered is replaced by the next, never stacked.
          ttl: '86400', urgency: 'normal', topic: 'keepsake',
        },
      });
      return r.status;
    } catch (e) {
      return e instanceof EgressError && e.status ? e.status : 0;
    }
  };
}

/** A notice to make in the queue (ADR 0010): who is told is worked out there, never in the request that caused it. */
/**
 * A change that tells someone. `people` only where the change itself names them (a draw's people); otherwise who is
 * told is found at the tick by the kind's resolver (`resolve`), so the request's work never depends on it.
 */
export interface Telling { kind: NoticeKind; subjectId: string; day: string; people?: string[]; again?: boolean }
/** Who a pending change of this kind tells, found at the tick from its subject and day. */
export type Resolver = (subjectId: string, day: string) => string[];

/** A push service failing with a 4xx other than 404, 410 or 429 for this long drops the subscription. */
export const FAILING_DAYS = 3;
/** A subscription its device has not confirmed (PUT again) for this long is dropped (PR #12 review, N4). */
export const CONFIRM_DAYS = 30;
const DAY = 86_400_000;

/**
 * The push queue (ADR 0010; PR #12 review, L6). A changing request only hands it what to tell (`tell`), and the
 * morning batch who it told (`wake`). On a fixed tick (every 30 s, plus up to 30 s at random) the queue makes the
 * notices, then encrypts and sends one push to each device of everyone told: no request does work that depends on who
 * is told, and a push's arrival is not the moment of the change. `idle()` runs the queue now (tests).
 *
 * Answers: 2xx sent; 404 or 410 drops the subscription; 429 holds back that push service for the rest of the tick
 * (its pushes wait for the next one); 5xx and a failure on our side change nothing; any other 4xx for FAILING_DAYS
 * drops it (PR #12 review, L4). A subscription not confirmed for CONFIRM_DAYS goes (N4).
 */
/** A pending row that fails is tried again after 1, 2, 4 … minutes (at most an hour), and set aside after this many tries. */
export const MAX_ATTEMPTS = 8;
/**
 * A row set aside is kept this long after its last try (its retry time), for whoever reads the log to look at it, then
 * pruned with the people it names (issue #13, 3; ADR 0010).
 */
export const SET_ASIDE_DAYS = 14;
/** stop() waits at most this long for pushes being sent (a hung push service must not hold up a shutdown, L1). */
export const STOP_WAIT_MS = 2_000;

export interface PusherOptions {
  tickMs?: number;
  jitterMs?: number;
  /** Where a failing pending row is reported: its id and kind only, never who or what (L2). */
  warn?: (message: string, fields: { pendingId: string; kind: string; attempts: number }) => void;
}

export class Pusher {
  private resolvers: Partial<Record<NoticeKind, Resolver>> = {};
  private held = new Set<string>();
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  constructor(private readonly db: Db, private readonly transport: Transport | null, private readonly o: PusherOptions = {}) {}

  /**
   * A notice to make (and push) at the next tick: one durable row (pending_notice), the same work however many are
   * told, so a stop or a crash before the tick loses nothing (PR #12 review, N-M1). Called inside the changing
   * request's own transaction, so the change and its row are kept or lost together (third review, L3).
   */
  tell(x: Telling): void {
    this.db.insert(t.pendingNotice).values({
      id: randomUUID(), kind: x.kind, subjectId: x.subjectId, day: x.day, again: x.again ? 1 : 0,
      people: x.people ? JSON.stringify(x.people) : null, createdAt: new Date().toISOString(),
    }).run();
  }
  /** How a kind finds who it tells (data.ts). */
  resolve(kind: NoticeKind, r: Resolver): void { this.resolvers[kind] = r; }
  /** People already told (the morning batch): pushed at the next tick, kept in the database until then. */
  wake(personIds: Iterable<string>, db: Db = this.db): void {
    if (!this.transport) return;
    const since = new Date().toISOString();
    for (const personId of new Set(personIds)) db.insert(t.pendingPush).values({ personId, since }).onConflictDoNothing().run();
  }

  /** Ticks from now on (main.ts, buildApp); never keeps the process alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    const arm = () => {
      // A tick that ends after stop() arms nothing (third review, L1).
      if (this.stopped) return;
      this.timer = setTimeout(() => { void this.tick().finally(arm); }, (this.o.tickMs ?? 30_000) + Math.random() * (this.o.jitterMs ?? 30_000));
      this.timer.unref();
    };
    arm();
  }
  /**
   * Stops for good: no tick after it, pushes being sent waited for at most STOP_WAIT_MS (the rest stay pending in the
   * database), and what is pending made into its notices, whose pushes go at the next start (L1, L4).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.running, new Promise<void>((ok) => { timer = setTimeout(ok, STOP_WAIT_MS); })]);
      clearTimeout(timer);
    }
    this.makeNotices();
  }

  /**
   * The pending changes that are due become notices, and everyone told something new a pending push, each row in one
   * transaction with them. A row that fails is reported without its content, tried again later and set aside after
   * MAX_ATTEMPTS; it never stops the other rows (third review, L2).
   */
  private makeNotices(): void {
    const now = new Date();
    const due = this.db.select().from(t.pendingNotice).where(and(lt(t.pendingNotice.attempts, MAX_ATTEMPTS), or(isNull(t.pendingNotice.nextAt), lte(t.pendingNotice.nextAt, now.toISOString()))))
      .orderBy(asc(t.pendingNotice.createdAt), asc(t.pendingNotice.id)).all();
    for (const x of due) {
      try {
        this.db.transaction((tx0) => {
          const tx = asDb(tx0);
          const named = x.people ? (JSON.parse(x.people) as string[]) : (this.resolvers[x.kind]?.(x.subjectId, x.day) ?? []);
          // Someone who left the household since the change is told nothing.
          const people = named.length ? tx.select({ id: t.person.id }).from(t.person).where(inArray(t.person.id, named)).all().map((p) => p.id) : [];
          this.wake(tell(tx, people, x.kind, x.subjectId, x.day, { again: Boolean(x.again) }), tx);
          tx.delete(t.pendingNotice).where(eq(t.pendingNotice.id, x.id)).run();
        });
      } catch {
        const attempts = x.attempts + 1;
        const nextAt = new Date(now.getTime() + Math.min(2 ** (attempts - 1), 60) * 60_000).toISOString();
        this.db.update(t.pendingNotice).set({ attempts, nextAt }).where(eq(t.pendingNotice.id, x.id)).run();
        this.o.warn?.(attempts >= MAX_ATTEMPTS ? 'a pending notice failed again and is set aside' : 'a pending notice failed; it is tried again later', { pendingId: x.id, kind: x.kind, attempts });
      }
    }
  }
  private pending(): boolean {
    const now = new Date().toISOString();
    return Boolean(this.db.select({ id: t.pendingNotice.id }).from(t.pendingNotice)
      .where(and(lt(t.pendingNotice.attempts, MAX_ATTEMPTS), or(isNull(t.pendingNotice.nextAt), lte(t.pendingNotice.nextAt, now)))).limit(1).get())
      || Boolean(this.db.select({ id: t.pendingPush.personId }).from(t.pendingPush).limit(1).get());
  }

  /** One tick: what was handed over so far is told and pushed. */
  tick(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  /** Ticks until nothing handed over is left (what a 429 held back waits for a real next tick). */
  async idle(): Promise<void> {
    while (this.running || this.pending()) await this.tick();
  }

  private async run(): Promise<void> {
    const now = Date.now();
    this.makeNotices();
    this.db.delete(t.pendingNotice).where(and(gte(t.pendingNotice.attempts, MAX_ATTEMPTS), lt(t.pendingNotice.nextAt, new Date(now - SET_ASIDE_DAYS * DAY).toISOString()))).run();
    if (!this.transport) { this.db.delete(t.pendingPush).run(); return; }
    // A session that has ended takes its device's subscription with it (the foreign key); unconfirmed ones go.
    pruneSessions(this.db);
    this.db.delete(t.pushSubscription).where(lt(t.pushSubscription.confirmedAt, new Date(now - CONFIRM_DAYS * DAY).toISOString())).run();
    const people = this.db.select().from(t.pendingPush).all().map((p) => p.personId);
    if (people.length) this.db.delete(t.pendingPush).where(inArray(t.pendingPush.personId, people)).run();
    const held = [...this.held];
    this.held.clear();
    const subs = this.db.select().from(t.pushSubscription).where(or(inArray(t.pushSubscription.personId, people), inArray(t.pushSubscription.id, held))).all();
    const throttled = new Set<string>();
    for (const [i, s] of subs.entries()) {
      // Stopping: the devices not reached yet keep their push pending, for the next start.
      if (this.stopped) { this.wake(subs.slice(i).map((x) => x.personId)); break; }
      const service = new URL(s.endpoint).hostname;
      if (throttled.has(service)) { this.held.add(s.id); continue; }
      let status: number;
      try { status = await this.transport(s); } catch { status = 0; }
      const at = new Date().toISOString();
      if (status >= 200 && status < 300) {
        if (s.failingSince) this.db.update(t.pushSubscription).set({ failingSince: null }).where(eq(t.pushSubscription.id, s.id)).run();
      } else if (status === 404 || status === 410) {
        this.db.delete(t.pushSubscription).where(eq(t.pushSubscription.id, s.id)).run();
      } else if (status === 429) {
        throttled.add(service);
        this.held.add(s.id);
      } else if (status >= 400 && status < 500) {
        if (!s.failingSince) this.db.update(t.pushSubscription).set({ failingSince: at }).where(eq(t.pushSubscription.id, s.id)).run();
        else if (Date.parse(at) - Date.parse(s.failingSince) > FAILING_DAYS * DAY) this.db.delete(t.pushSubscription).where(eq(t.pushSubscription.id, s.id)).run();
      }
      // 5xx, or nothing (a failure on our side or the network's): the subscription stays as it is.
    }
  }
}
