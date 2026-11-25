import { buildApp } from './app';
import { ensureSetupLink } from './auth/invites';
import { pruneSessions } from './auth/sessions';
import { loadConfig } from './config';
import { openDb } from './db/open';
import { SealError, keyFileWarning, sealingKey } from './draws/sealed';
import { scheduleMorning } from './jobs/morning';
import { vapidKey } from './push/keys';

// Everything Keepsake writes (the database, its WAL, the setup link) is for its own user only. Imports write nothing,
// so this runs before any file is made.
process.umask(0o077);
const cfg = loadConfig(); // refuses to start in homerslab mode without its settings
const db = openDb(cfg.dbFile); // creates and migrates the database in the data folder
const { app, morning } = await buildApp(cfg, db, { logger: true });
pruneSessions(db);
// The draws' key (ADR 0004): standalone makes its file once here; without a usable key Keepsake runs, but draws are
// refused. Only the reason is logged, never the key.
try {
  if (!sealingKey(cfg)) app.log.warn('no sealing key (KEEPSAKE_SEALING_KEY): draws are off until it is set');
} catch (e) {
  app.log.warn(`the sealing key is not usable (${e instanceof SealError ? e.message : 'it cannot be read'}): draws are off until it is fixed`);
}
// Web Push's key (ADR 0010): standalone makes its file once here, like the sealing key; without one, no push.
try {
  if (!cfg.egress) app.log.warn('KEEPSAKE_EGRESS=off: no push and no page read from a shop link');
  else if (!vapidKey(cfg)) app.log.warn('no VAPID key (KEEPSAKE_VAPID_KEY): push is off until it is set');
} catch (e) {
  app.log.warn(`the VAPID key is not usable (${e instanceof Error ? e.message : 'it cannot be read'}): push is off until it is fixed`);
}
const keyWarning = keyFileWarning(cfg);
if (keyWarning) app.log.warn(keyWarning);
const setupFile = ensureSetupLink(db, cfg);
if (setupFile) app.log.warn(`Keepsake needs its first admin: open the link in ${setupFile} (valid 24 hours, once)`);
await app.listen({ host: cfg.host, port: cfg.port });
// The morning batch (ADR 0008, 0010): 08:00 household time, and now if today's has not run.
scheduleMorning(db, cfg, (now) => { try { morning(now); } catch (e) { app.log.error(e, 'the morning batch failed'); } });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
