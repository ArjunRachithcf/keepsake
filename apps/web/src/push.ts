// This device's push subscription, kept in step with the server (PR #12 review, M2, L7). Plain functions over the
// browser's PushManager, so they are tested without a browser (test/push.test.ts).

export const b64uToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

export interface PushServer {
  /**
   * PUT /api/push/subscription: keeps it for this person and confirms it (the server drops one unconfirmed for 30
   * days). `sync`: the app's own re-sending, which never moves a device from another person (only the switch does).
   */
  put: (subscription: PushSubscriptionJSON, sync?: boolean) => Promise<unknown>;
  /** POST /api/push/unsubscribe. */
  drop: (endpoint: string) => Promise<unknown>;
}

/** A subscription for the server's current key: one made for an earlier key is ended and made again (L7). */
export async function freshSubscription(pm: PushManager, key: Uint8Array, server: PushServer): Promise<PushSubscription> {
  const old = await pm.getSubscription();
  if (old && sameKey(old.options.applicationServerKey, key)) return old;
  if (old) {
    await server.drop(old.endpoint).catch(() => undefined);
    await old.unsubscribe().catch(() => false);
  }
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
}

/** Which person turned notifications on in this browser (PR #12 second review, N-M2): the only one it re-sends for. */
export interface Owner { get: () => string | null; set: (personId: string | null) => void }
const OWNER_KEY = 'keepsake.push.person';
export const browserOwner: Owner = {
  get: () => { try { return localStorage.getItem(OWNER_KEY); } catch { return null; } },
  set: (p) => { try { if (p) localStorage.setItem(OWNER_KEY, p); else localStorage.removeItem(OWNER_KEY); } catch { /* nothing kept: no re-sending */ } },
};

/**
 * At every start of the app and whenever it is shown again (M2): the subscription this device already has goes to the
 * server again, so a session that ended (idle, 30 days) or a server that lost it gets it back, and its confirmation
 * stays fresh. A device without a subscription, or one another person turned on, is left alone: only the switch asks
 * for notifications, and only the switch moves a device from one person to another.
 */
export async function syncSubscription(pm: PushManager, publicKey: string | null | undefined, server: PushServer, me: string, owner: Owner): Promise<boolean> {
  // Someone else turned them on in this browser (a family computer): theirs stay theirs; the switch shows off for me.
  if (!publicKey || owner.get() !== me || !(await pm.getSubscription())) return false;
  const sub = await freshSubscription(pm, b64uToBytes(publicKey), server);
  await server.put(sub.toJSON(), true);
  return true;
}
