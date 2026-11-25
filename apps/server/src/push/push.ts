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
import { createHash } from 'node:crypto';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { Refused } from '../errors';
import { allowed, EgressError, PUSH_HOSTS, type Egress } from '../net/egress';
import { pruneSessions } from '../auth/sessions';
import { encrypt, validClientKey, vapidAuthorization, type Vapid } from './webpush';

export type Subscription = typeof t.pushSubscription.$inferSelect;
export const MAX_DEVICES = 10;
/** The one message every push carries (ADR 0010). */
export const PAYLOAD = Buffer.from('{"v":1}');
/** Failures in a row after which a subscription is dropped (a 404 or 410 drops it at once). */
const MAX_FAILURES = 5;

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

/** Keeps a device's subscription for the caller (moved to them if another person had it on that device). */
export function subscribe(db: Db, personId: string, sessionId: string | null, i: SubscriptionInput, now = new Date()): void {
  const s = checkSubscription(i);
  const id = subscriptionId(s.endpoint);
  db.transaction((tx) => {
    tx.delete(t.pushSubscription).where(eq(t.pushSubscription.id, id)).run();
    tx.insert(t.pushSubscription).values({ id, personId, sessionId, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, createdAt: now.toISOString() }).run();
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

/**
 * The push queue: `wake(people)` after a change or the morning batch, and each of their devices gets one push, one
 * after another, outside every request. `idle()` resolves when the queue is empty (the tests wait on it).
 */
export class Pusher {
  private waiting = new Set<string>();
  private running: Promise<void> | null = null;
  constructor(private readonly db: Db, private readonly transport: Transport | null) {}

  wake(personIds: Iterable<string>): void {
    if (!this.transport) return;
    for (const p of personIds) this.waiting.add(p);
    if (this.waiting.size && !this.running) this.running = this.drain().finally(() => { this.running = null; });
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    // The queue runs after the request that woke it has answered.
    await new Promise((ok) => setImmediate(ok));
    while (this.waiting.size) {
      const people = [...this.waiting];
      this.waiting.clear();
      // A session that has ended takes its device's subscription with it (the foreign key), before anything is sent.
      pruneSessions(this.db);
      const subs = this.db.select().from(t.pushSubscription).where(inArray(t.pushSubscription.personId, people)).all();
      for (const s of subs) {
        let status: number;
        try { status = await this.transport!(s); } catch { status = 0; }
        if (status >= 200 && status < 300) {
          if (s.failures) this.db.update(t.pushSubscription).set({ failures: 0 }).where(eq(t.pushSubscription.id, s.id)).run();
        } else if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES) {
          // Gone (the browser unsubscribed, or the service no longer knows it), or failing again and again.
          this.db.delete(t.pushSubscription).where(eq(t.pushSubscription.id, s.id)).run();
        } else {
          this.db.update(t.pushSubscription).set({ failures: s.failures + 1 }).where(eq(t.pushSubscription.id, s.id)).run();
        }
      }
    }
  }
}
