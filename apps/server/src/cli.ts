// `keepsake recover <admin id>` (Philobiblos ADR 0010): when an admin has lost every passkey, whoever runs Keepsake's
// container writes a one-time link (24 hours) for that admin into KEEPSAKE_KEYS_DIR/setup-link.txt (0600), never into
// the data folder (its backup must not carry a live admin link, Gate routes L2), the terminal or a log. Using it removes the admin's other passkeys and ends their sessions. `keepsake admins` lists the admins' ids and names to pick from.
// `keepsake rotate-key` (ADR 0004): with the new key as KEEPSAKE_SEALING_KEY and the old one as
// KEEPSAKE_SEALING_KEY_PREVIOUS, seals every draw's rows again with the new key; it prints counts, never a key or a pair.
import { createRecoveryLink } from './auth/invites';
import { loadConfig } from './config';
import { openDb } from './db/open';
import { household } from './household/people';
import { rotateKey } from './draws/draws';
import { keyring } from './draws/sealed';

// Everything it writes is for Keepsake's user only.
process.umask(0o077);
const [cmd, arg, ...rest] = process.argv.slice(2);
try {
  const cfg = loadConfig();
  if (cmd === 'admins' && !arg) {
    for (const p of household(openDb(cfg.dbFile)).filter((x) => x.role === 'admin')) console.log(`${p.id}  ${p.name}`);
  } else if (cmd === 'recover' && arg && !rest.length) {
    const file = createRecoveryLink(openDb(cfg.dbFile), cfg, arg);
    console.log(`A one-time link (24 hours) is in ${file}. Open it on the new device; it is removed once used.`);
  } else if (cmd === 'rotate-key' && !arg) {
    const { resealed, unreadable } = rotateKey(openDb(cfg.dbFile), keyring(cfg));
    console.log(`Sealed ${resealed} draw rows again with the current key.${unreadable ? ` ${unreadable} open with neither key: their draws need drawing again.` : ''}`);
  } else {
    console.error('usage: keepsake admins | keepsake recover <admin id> | keepsake rotate-key');
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
