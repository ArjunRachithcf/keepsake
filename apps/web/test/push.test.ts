// This device's subscription kept in step with the server (PR #12 review, M2: sent again at every start; L7: made
// again when the server's key changed). A fake PushManager stands in for the browser's.
import { describe, expect, it } from 'vitest';
import { b64uToBytes, freshSubscription, syncSubscription, type Owner, type PushServer } from '../src/push';

const KEY_A = Buffer.alloc(65, 4).toString('base64url');
const KEY_B = Buffer.alloc(65, 5).toString('base64url');

function fakePushManager(existing?: string) {
  let n = 0;
  const made: string[] = [];
  const sub = (key: Uint8Array) => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/d${++n}`;
    const s = {
      endpoint, options: { applicationServerKey: key.slice().buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => { current = null; return true; },
    };
    made.push(endpoint);
    return s;
  };
  let current: ReturnType<typeof sub> | null = existing ? sub(b64uToBytes(existing)) : null;
  const pm = {
    getSubscription: async () => current,
    subscribe: async (o: { applicationServerKey: Uint8Array }) => (current = sub(o.applicationServerKey)),
  } as unknown as PushManager;
  return { pm, made, current: () => current };
}

const ownedBy = (p: string | null): Owner => { let v = p; return { get: () => v, set: (x) => { v = x; } }; };

function fakeServer() {
  const calls: string[] = [];
  const server: PushServer = {
    put: async (s, sync) => { calls.push(`put ${s.endpoint}${sync ? ' sync' : ''}`); },
    drop: async (e) => { calls.push(`drop ${e}`); },
  };
  return { server, calls };
}

describe('the app keeps its subscription at the server', () => {
  it('sends the subscription it has at every start and every showing (M2)', async () => {
    const { pm } = fakePushManager(KEY_A);
    const { server, calls } = fakeServer();
    for (let i = 0; i < 3; i++) expect(await syncSubscription(pm, KEY_A, server, 'p_alex', ownedBy('p_alex'))).toBe(true);
    expect(calls).toEqual(Array(3).fill('put https://fcm.googleapis.com/fcm/send/d1 sync'));
  });

  it('a device without one is not asked: only the switch subscribes', async () => {
    const { pm, made } = fakePushManager();
    const { server, calls } = fakeServer();
    expect(await syncSubscription(pm, KEY_A, server, 'p_alex', ownedBy('p_alex'))).toBe(false);
    expect([made, calls]).toEqual([[], []]);
  });

  it('a browser someone else turned notifications on in sends nothing for me, nor does one nobody claimed (PR #12 second review, N-M2)', async () => {
    const { pm, made } = fakePushManager(KEY_A);
    const { server, calls } = fakeServer();
    expect(await syncSubscription(pm, KEY_A, server, 'p_robin', ownedBy('p_alex'))).toBe(false);
    expect(await syncSubscription(pm, KEY_B, server, 'p_robin', ownedBy('p_alex'))).toBe(false);
    expect(await syncSubscription(pm, KEY_A, server, 'p_robin', ownedBy(null))).toBe(false);
    expect([made.length, calls]).toEqual([1, []]);
  });

  it('a subscription made for another key is ended (here and at the server) and made again for the new one (L7)', async () => {
    const f = fakePushManager(KEY_A);
    const { server, calls } = fakeServer();
    await syncSubscription(f.pm, KEY_B, server, 'p_alex', ownedBy('p_alex'));
    expect(calls).toEqual(['drop https://fcm.googleapis.com/fcm/send/d1', 'put https://fcm.googleapis.com/fcm/send/d2 sync']);
    expect(new Uint8Array(f.current()!.options.applicationServerKey)).toEqual(b64uToBytes(KEY_B));
  });

  it('the switch reuses a subscription for the same key and replaces one for another (L7)', async () => {
    const f = fakePushManager(KEY_A);
    const { server } = fakeServer();
    expect((await freshSubscription(f.pm, b64uToBytes(KEY_A), server)).endpoint).toBe('https://fcm.googleapis.com/fcm/send/d1');
    expect((await freshSubscription(f.pm, b64uToBytes(KEY_B), server)).endpoint).toBe('https://fcm.googleapis.com/fcm/send/d2');
  });
});
