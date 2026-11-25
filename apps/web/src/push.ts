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
  /** PUT /api/push/subscription: keeps it for this person and confirms it (the server drops one unconfirmed for 30 days). */
  put: (subscription: PushSubscriptionJSON) => Promise<unknown>;
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

/**
 * At every start of the app and whenever it is shown again (M2): the subscription this device already has goes to the
 * server again, so a session that ended (idle, 30 days) or a server that lost it gets it back, and its confirmation
 * stays fresh. A device without a subscription is left alone: only the switch asks for notifications.
 */
export async function syncSubscription(pm: PushManager, publicKey: string | null | undefined, server: PushServer): Promise<boolean> {
  if (!publicKey || !(await pm.getSubscription())) return false;
  const sub = await freshSubscription(pm, b64uToBytes(publicKey), server);
  await server.put(sub.toJSON());
  return true;
}
