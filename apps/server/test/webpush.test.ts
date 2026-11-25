// Web Push's encryption (RFC 8291) and VAPID (RFC 8292) with node:crypto, and the VAPID key kept as the sealing key
// is (ADR 0010): its file made once, 0600, never in the data folder, never in a log.
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { vapidKey } from '../src/push/keys';
import { PAYLOAD } from '../src/push/push';
import { derive, encrypt, newVapidKey, validClientKey, vapidAuthorization, vapidFrom } from '../src/push/webpush';

const d = (s: string) => Buffer.from(s, 'base64url');
// RFC 8291 Appendix A: the user agent's keys, the server's ephemeral key and the salt of its example.
const UA_PRIVATE = d('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
const UA_PUBLIC = d('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
const AUTH = d('BTBZMqHH6r4Tts7J_aSIgg');
const AS_PRIVATE = d('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
const SALT = d('DGv6ra1nlYgDCS1FRnbzlw');

/** The user agent's side (RFC 8291 §3.4 the other way round): what a browser would read. */
function decrypt(uaPrivate: Buffer, auth: Buffer, msg: Buffer): Buffer {
  const salt = msg.subarray(0, 16);
  const idlen = msg[20]!;
  const asPublic = msg.subarray(21, 21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const ecdh = ua.computeSecret(asPublic);
  const hmac = (k: Buffer, ...x: Buffer[]) => { const h = createHmac('sha256', k); for (const y of x) h.update(y); return h.digest(); };
  const ikm = hmac(hmac(auth, ecdh), Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const body = msg.subarray(21 + idlen);
  const c = createDecipheriv('aes-128-gcm', cek, nonce);
  c.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([c.update(body.subarray(0, body.length - 16)), c.final()]);
  const end = plain.lastIndexOf(2);
  expect(plain.subarray(end + 1).every((b) => b === 0)).toBe(true);
  return plain.subarray(0, end);
}

describe('RFC 8291', () => {
  it('derives the content key and nonce of the RFC\'s example', () => {
    const k = derive({ p256dh: UA_PUBLIC, auth: AUTH }, AS_PRIVATE, SALT);
    expect(k.asPublic.toString('base64url')).toBe('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    expect(k.cek.toString('base64url')).toBe('oIhVW04MRdy2XN9CiKLxTg');
    expect(k.nonce.toString('base64url')).toBe('4h_95klXJ5E_qnoN');
  });

  it('encrypts so the browser reads it, with the RFC\'s header (salt, rs 4096, the key)', () => {
    const plain = Buffer.from('When I grow up, I want to be a watermelon');
    const msg = encrypt({ p256dh: UA_PUBLIC, auth: AUTH }, plain, { ephemeral: AS_PRIVATE, salt: SALT });
    expect(msg.subarray(0, 16)).toEqual(SALT);
    expect(msg.readUInt32BE(16)).toBe(4096);
    expect(msg[20]).toBe(65);
    expect(decrypt(UA_PRIVATE, AUTH, msg)).toEqual(plain);
  });

  it('every Keepsake push is the same length and says only {"v":1}; each is encrypted afresh', () => {
    const a = encrypt({ p256dh: UA_PUBLIC, auth: AUTH }, PAYLOAD, { padTo: 32 });
    const b = encrypt({ p256dh: UA_PUBLIC, auth: AUTH }, PAYLOAD, { padTo: 32 });
    expect(a.length).toBe(b.length);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(UA_PRIVATE, AUTH, a).toString()).toBe('{"v":1}');
  });

  it('a browser key must be a point on P-256', () => {
    expect(validClientKey(UA_PUBLIC)).toBe(true);
    expect(validClientKey(Buffer.alloc(65, 4))).toBe(false);
    expect(validClientKey(UA_PUBLIC.subarray(1))).toBe(false);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('a JWT for the push service\'s origin, 12 hours, ES256, verifiable with the public key it names', () => {
    const v = vapidFrom(newVapidKey());
    const h = vapidAuthorization(v, 'https://fcm.googleapis.com/fcm/send/abc?x=1', 'mailto:keepsake@example.org', new Date('2026-12-01T10:00:00Z'));
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(d(k!)).toEqual(v.publicKey);
    const [head, claims, sig] = jwt!.split('.');
    expect(JSON.parse(d(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(d(claims!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-12-01T22:00:00Z') / 1000, sub: 'mailto:keepsake@example.org' });
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: v.publicKey.subarray(1, 33).toString('base64url'), y: v.publicKey.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, d(sig!))).toBe(true);
  });

  it('a key is always 32 bytes', () => { for (let i = 0; i < 50; i++) expect(newVapidKey().length).toBe(32); });
});

describe('the VAPID key is kept as the sealing key is', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'keepsake-vapid-'));
  it('standalone makes keys/vapid.key once, 0600 in a 0700 folder, and reads the same key again', () => {
    const root = dir();
    const env = { KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: join(root, 'data'), KEEPSAKE_KEYS_DIR: join(root, 'keys'), KEEPSAKE_SEALING_KEY: Buffer.alloc(32, 1).toString('base64') };
    const a = vapidKey(loadConfig(env))!;
    const file = join(root, 'keys', 'vapid.key');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'keys')).mode & 0o777).toBe(0o700);
    expect(vapidKey(loadConfig(env))!.publicKey).toEqual(a.publicKey);
    expect(d(readFileSync(file, 'utf8').trim()).length).toBe(32);
  });

  it('never in the data folder; never in the configuration\'s JSON; a bad value is refused', () => {
    const root = dir();
    expect(() => loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: root, KEEPSAKE_VAPID_KEY_FILE: join(root, 'vapid.key') })).toThrow(/VAPID key must not be in KEEPSAKE_DATA_DIR/);
    expect(() => loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: join(root, 'data'), KEEPSAKE_KEYS_DIR: join(root, 'data') })).toThrow(/must not be in KEEPSAKE_DATA_DIR/);
    const secret = Buffer.alloc(32, 9).toString('base64url');
    const cfg = loadConfig({ KEEPSAKE_MODE: 'homerslab', KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1', KEEPSAKE_TRUSTED_PROXY: '10.0.0.1', KEEPSAKE_ORIGIN: 'https://k.example', KEEPSAKE_DATA_DIR: root, KEEPSAKE_VAPID_KEY: secret });
    expect(JSON.stringify(cfg)).not.toContain(secret);
    expect(() => vapidKey({ vapidKey: { value: 'short' } })).toThrow(/32 bytes/);
    const named = join(dir(), 'gone.key');
    expect(() => vapidKey({ vapidKey: { file: named, create: false } })).toThrow(/names no file/);
    writeFileSync(named, 'not a key\n');
    expect(() => vapidKey({ vapidKey: { file: named, create: false } })).toThrow(/32 bytes/);
  });

  it('homerslab mode without the secret has no key (no push), and makes no file', () => {
    const cfg = loadConfig({ KEEPSAKE_MODE: 'homerslab', KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1', KEEPSAKE_TRUSTED_PROXY: '10.0.0.1', KEEPSAKE_ORIGIN: 'https://k.example', KEEPSAKE_DATA_DIR: dir() });
    expect(cfg.vapidKey).toBeNull();
    expect(cfg.vapidSubject).toBe('https://k.example');
  });

  it('the settings: KEEPSAKE_EGRESS on or off, a VAPID subject that is mailto: or https:, shops by host name only', () => {
    const base = { KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: '/nonexistent', KEEPSAKE_SEALING_KEY: 'x', KEEPSAKE_VAPID_KEY: 'x' };
    expect(loadConfig(base).egress).toBe(true);
    expect(loadConfig({ ...base, KEEPSAKE_EGRESS: 'off' }).egress).toBe(false);
    expect(() => loadConfig({ ...base, KEEPSAKE_EGRESS: 'no' })).toThrow(/on or off/);
    expect(() => loadConfig({ ...base, KEEPSAKE_VAPID_SUBJECT: 'someone' })).toThrow(/mailto/);
    expect(loadConfig({ ...base, KEEPSAKE_SHOP_HOSTS: ' Shop.Example , www.shop.example,shop.example' }).shopHosts).toEqual(['shop.example', 'www.shop.example']);
    expect(loadConfig(base).shopHosts).toEqual([]);
    for (const bad of ['https://shop.example', 'shop.example:443', 'shop.example/x', '10.0.0.1', 'localhost', '*.shop.example', '[::1]']) {
      expect(() => loadConfig({ ...base, KEEPSAKE_SHOP_HOSTS: bad }), bad).toThrow(/host names only/);
    }
  });
});
