// Web Push's message encryption (RFC 8291, aes128gcm of RFC 8188) and the server's identity for the push services
// (VAPID, RFC 8292), with node:crypto only. Keepsake's payload is one fixed, generic message (ADR 0010): the encryption
// is there because browsers require it for any payload, and so that the push service learns nothing but its length.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const hmac = (key: Buffer, ...data: Buffer[]) => { const h = createHmac('sha256', key); for (const d of data) h.update(d); return h.digest(); };
const ONE = Buffer.from([1]);

/** A browser's subscription keys: its P-256 public key (65 bytes, uncompressed) and its 16-byte auth secret. */
export interface ClientKeys { p256dh: Buffer; auth: Buffer }

/** Whether a public key is a point on P-256 (an ECDH with it works). */
export function validClientKey(p256dh: Buffer): boolean {
  if (p256dh.length !== 65 || p256dh[0] !== 4) return false;
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(p256dh); return true; } catch { return false; }
}

/** Record size: one record carries the whole message (it is a few bytes). */
const RS = 4096;

/**
 * Encrypts `plain` for one subscription (RFC 8291 §3.4): an ephemeral key pair and salt per message (passed in only by
 * the RFC's test vector), padded to `padTo` bytes of plaintext so every message has one length.
 */
/** The content key and nonce for one message (RFC 8291 §3.3, 3.4; RFC 8188 §2.2, 2.3). */
export function derive(keys: ClientKeys, asPrivate: Buffer, salt: Buffer): { asPublic: Buffer; cek: Buffer; nonce: Buffer } {
  const as = createECDH('prime256v1');
  as.setPrivateKey(asPrivate);
  const asPublic = as.getPublicKey();
  const ecdh = as.computeSecret(keys.p256dh);
  // IKM = HKDF(auth, ecdh, "WebPush: info" || 0 || ua_public || as_public, 32)
  const prkKey = hmac(keys.auth, ecdh);
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), keys.p256dh, asPublic, ONE);
  const prk = hmac(salt, ikm);
  return {
    asPublic,
    cek: hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), ONE).subarray(0, 16),
    nonce: hmac(prk, Buffer.from('Content-Encoding: nonce\0'), ONE).subarray(0, 12),
  };
}

/**
 * Encrypts `plain` for one subscription (RFC 8291 §3.4): an ephemeral key pair and salt per message (passed in only by
 * the RFC's test vector), padded to `padTo` bytes of plaintext so every message has one length.
 */
export function encrypt(keys: ClientKeys, plain: Buffer, o: { padTo?: number; ephemeral?: Buffer; salt?: Buffer } = {}): Buffer {
  const ephemeral = o.ephemeral ?? newVapidKey();
  const salt = o.salt ?? randomBytes(16);
  const { asPublic, cek, nonce } = derive(keys, ephemeral, salt);
  const pad = Math.max(0, (o.padTo ?? 0) - plain.length);
  // The last (and only) record: the message, its delimiter 0x02, then zeros.
  const record = Buffer.concat([plain, Buffer.from([2]), Buffer.alloc(pad)]);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(record), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The server's VAPID key pair from its 32-byte private scalar. */
export interface Vapid { publicKey: Buffer; privateKey: KeyObject }
export function vapidFrom(d: Buffer): Vapid {
  if (d.length !== 32) throw new Error('the VAPID key must be 32 bytes');
  const e = createECDH('prime256v1');
  e.setPrivateKey(d);
  const pub = e.getPublicKey();
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  return { publicKey: pub, privateKey };
}
/** A new VAPID private scalar (standalone makes one once, push/keys.ts). */
export function newVapidKey(): Buffer {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const k = e.getPrivateKey();
  // A scalar with leading zero bytes comes back shorter: the key is always 32 bytes.
  return Buffer.concat([Buffer.alloc(32 - k.length), k]);
}

/** The Authorization header for one push service (RFC 8292): a JWT for its origin, 12 hours, signed ES256. */
export function vapidAuthorization(v: Vapid, endpoint: string, subject: string, now = new Date()): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: v.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(v.publicKey)}`;
}
