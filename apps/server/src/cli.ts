// `keepsake recover <admin id>` (Philobiblos ADR 0010): when an admin has lost every passkey, whoever runs Keepsake's
// container writes a one-time link (24 hours) for that admin into KEEPSAKE_DATA_DIR/setup-link.txt (0600), never to
// the terminal or a log. `keepsake admins` lists the admins' ids and names to pick from.
import { createRecoveryLink } from './auth/invites';
import { loadConfig } from './config';
import { openDb } from './db/open';
import { household } from './household/people';

const [cmd, arg, ...rest] = process.argv.slice(2);
try {
  const cfg = loadConfig();
  if (cmd === 'admins' && !arg) {
    for (const p of household(openDb(cfg.dbFile)).filter((x) => x.role === 'admin')) console.log(`${p.id}  ${p.name}`);
  } else if (cmd === 'recover' && arg && !rest.length) {
    const file = createRecoveryLink(openDb(cfg.dbFile), cfg, arg);
    console.log(`A one-time link (24 hours) is in ${file}. Open it on the new device; it is removed once used.`);
  } else {
    console.error('usage: keepsake admins | keepsake recover <admin id>');
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
