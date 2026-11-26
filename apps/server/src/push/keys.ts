// The VAPID key (ADR 0010), kept as the sealing key is (ADR 0004): KEEPSAKE_VAPID_KEY or _FILE; standalone makes
// KEEPSAKE_KEYS_DIR/vapid.key once (O_EXCL, 0600, the folder 0700); never in the data folder (config.ts refuses it),
// never logged. Whoever holds it can send pushes to the household's devices as this Keepsake (they would still say
// only "Something new"), so it stays out of the database and its backups.
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';
import { newVapidKey, vapidFrom, type Vapid } from './webpush';

const KEYS = new WeakMap<object, Vapid>();

/**
 * Read as the sealing key is (draws/sealed.ts): base64 or base64url, both alphabets (HomersLab's manifest cannot say
 * which a generated secret uses; PR #12 review, M3), and it must be 32 bytes.
 */
function decode(text: string): Buffer {
  const k = Buffer.from(text.trim(), 'base64');
  if (k.length !== 32) throw new Error('the VAPID key must be 32 bytes, base64 or base64url');
  return k;
}

/** The key pair, or null when none is configured. Throws for a key that is not usable (the reason only, never the key). */
export function vapidKey(cfg: Pick<Config, 'vapidKey'>): Vapid | null {
  const src = cfg.vapidKey;
  if (!src) return null;
  const known = KEYS.get(src);
  if (known) return known;
  let d: Buffer;
  if ('value' in src) d = decode(src.value);
  else {
    if (!existsSync(src.file)) {
      if (!src.create) throw new Error('KEEPSAKE_VAPID_KEY_FILE names no file');
      mkdirSync(dirname(src.file), { recursive: true, mode: 0o700 });
      try { chmodSync(dirname(src.file), 0o700); } catch { /* not ours to change: the file itself is 0600 */ }
      try {
        const fd = openSync(src.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeSync(fd, newVapidKey().toString('base64url') + '\n');
        closeSync(fd);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    d = decode(readFileSync(src.file, 'utf8'));
  }
  const v = vapidFrom(d);
  KEYS.set(src, v);
  return v;
}

/** The key pair, or null when there is none or it cannot be read. */
export function usableVapid(cfg: Pick<Config, 'vapidKey'>): Vapid | null {
  try { return vapidKey(cfg); } catch { return null; }
}
