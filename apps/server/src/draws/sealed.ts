// Sealed draws (ADR 0004, docs/security.md): each giver's receiver is sealed on its own with AES-256-GCM under a key
// that is never in the database or its backup (config.sealingKey, loaded as Philobiblos loads its sealing key). The
// draw's and the giver's ids are bound to the ciphertext as associated data, so a row moved to another giver (or
// another draw) does not open; the plaintext is padded to one length, so no row's size says whose id it holds. The key
// and the plaintexts never reach a log or an answer: only the view layer turns an opened row into a person, for the
// giver it belongs to (or for every participant after the host's reveal date).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';

export class SealError extends Error {}

const KEYS = new WeakMap<object, Buffer>();

function decode(text: string): Buffer {
  const k = Buffer.from(text.trim(), 'base64');
  if (k.length !== 32) throw new SealError('the sealing key must be 32 bytes, base64');
  return k;
}

/**
 * The key, or null when none is configured. Standalone makes its key file once (O_EXCL, 0600) in its keys folder.
 * Throws SealError for a key that is not 32 bytes of base64, or a named file that is not there.
 */
export function sealingKey(cfg: Pick<Config, 'sealingKey'>): Buffer | null {
  return loadKey(cfg.sealingKey);
}

function loadKey(src: Config['sealingKey']): Buffer | null {
  if (!src) return null;
  const known = KEYS.get(src);
  if (known) return known;
  let key: Buffer;
  if ('value' in src) key = decode(src.value);
  else {
    if (!existsSync(src.file)) {
      if (!src.create) throw new SealError('KEEPSAKE_SEALING_KEY_FILE names no file');
      mkdirSync(dirname(src.file), { recursive: true, mode: 0o700 });
      // The keys folder too, when it is ours (made by `mkdir keys` with the usual umask, it would be 0755).
      try { chmodSync(dirname(src.file), 0o700); } catch { /* not ours to change: the file itself is 0600 */ }
      try {
        const fd = openSync(src.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeSync(fd, randomBytes(32).toString('base64') + '\n');
        closeSync(fd);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    key = decode(readFileSync(src.file, 'utf8'));
  }
  KEYS.set(src, key);
  return key;
}

/** The key, or null when there is none or it cannot be read (the reason is not the caller's to show). */
export function usableKey(cfg: Pick<Config, 'sealingKey'>): Buffer | null {
  try { return sealingKey(cfg); } catch { return null; }
}

/** A problem with a key file others could read (group or others have any permission): for a warning at start. */
export function keyFileWarning(cfg: Pick<Config, 'sealingKey' | 'sealingKeyPrevious'> & Partial<Pick<Config, 'vapidKey'>>): string | null {
  for (const src of [cfg.sealingKey, cfg.sealingKeyPrevious, cfg.vapidKey ?? null]) {
    if (src && 'file' in src && existsSync(src.file) && (statSync(src.file).mode & 0o077)) return `${src.file} can be read by other accounts: chmod 600 it`;
  }
  return null;
}

/**
 * The keys that open rows: the current one (which also seals) and a previous one (KEEPSAKE_SEALING_KEY_PREVIOUS), each
 * picked by the row's key id. A key that cannot be read is no key.
 */
/** The current and the previous sealing key, those that can be read (for keyed fingerprints, like the import's). */
export function sealingKeys(cfg: Pick<Config, 'sealingKey' | 'sealingKeyPrevious'>): Buffer[] {
  let previous: Buffer | null;
  try { previous = loadKey(cfg.sealingKeyPrevious); } catch { previous = null; }
  return [usableKey(cfg), previous].filter((k): k is Buffer => k !== null);
}

export interface Keyring { current: Buffer | null; byId(id: string): Buffer | null }
export function keyring(cfg: Pick<Config, 'sealingKey' | 'sealingKeyPrevious'>): Keyring {
  const current = usableKey(cfg);
  let previous: Buffer | null;
  try { previous = loadKey(cfg.sealingKeyPrevious); } catch { previous = null; }
  const ids = new Map<string, Buffer>();
  for (const k of [previous, current]) if (k) ids.set(keyId(k), k);
  return { current, byId: (id) => ids.get(id) ?? null };
}

/** A short public name for a key (which key sealed a row), not the key. */
export const keyId = (key: Buffer) => createHash('sha256').update('keepsake-draw-key').update(key).digest('hex').slice(0, 12);

const PLAIN = 96;
const TAG = 16;
/** Every sealed row's length: IV, a 16-byte tag (pinned: no shorter tag is accepted), the padded plaintext. */
export const SEALED_LENGTH = 12 + TAG + PLAIN;
const aad = (drawId: string, giverId: string) => Buffer.from(`keepsake-draw:v1:${drawId}:${giverId}`);

/** One giver's receiver, sealed: IV (12) + tag (16) + ciphertext (PLAIN). */
export function sealReceiver(key: Buffer, drawId: string, giverId: string, receiverId: string): Buffer {
  const text = Buffer.from(JSON.stringify({ r: receiverId }));
  if (text.length > PLAIN) throw new Error('sealed: an id too long to seal');
  const plain = Buffer.concat([text, Buffer.alloc(PLAIN - text.length, 0x20)]);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  c.setAAD(aad(drawId, giverId));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

/** The receiver's id, or SealError for a wrong key, a changed row or a row moved from another giver or draw. */
export function openReceiver(key: Buffer, drawId: string, giverId: string, sealed: Buffer): string {
  try {
    if (sealed.length !== SEALED_LENGTH) throw new Error('not a sealed row');
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12), { authTagLength: TAG });
    d.setAAD(aad(drawId, giverId));
    d.setAuthTag(sealed.subarray(12, 12 + TAG));
    const plain = Buffer.concat([d.update(sealed.subarray(12 + TAG)), d.final()]).toString('utf8');
    const r = (JSON.parse(plain.trimEnd()) as { r?: unknown }).r;
    if (typeof r !== 'string') throw new Error('no receiver');
    return r;
  } catch { throw new SealError('the sealed row does not open'); }
}

/** A stored row opened with whichever key its key id names, or null when that key is not here or the row does not open. */
export function openRow(ring: Keyring, drawId: string, row: { giverId: string; sealed: Buffer; keyId: string }): string | null {
  const key = ring.byId(row.keyId);
  if (!key) return null;
  try { return openReceiver(key, drawId, row.giverId, row.sealed); } catch { return null; }
}
