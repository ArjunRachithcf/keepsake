import { buildApp } from './app';
import { ensureSetupLink } from './auth/invites';
import { pruneSessions } from './auth/sessions';
import { loadConfig } from './config';
import { openDb } from './db/open';
import { SealError, sealingKey } from './draws/sealed';

// Everything Keepsake writes (the database, its WAL, the setup link) is for its own user only. Imports write nothing,
// so this runs before any file is made.
process.umask(0o077);
const cfg = loadConfig(); // refuses to start in homerslab mode without its settings
const db = openDb(cfg.dbFile); // creates and migrates the database in the data folder
const { app } = await buildApp(cfg, db, { logger: true });
pruneSessions(db);
// The draws' key (ADR 0004): standalone makes its file once here; without a usable key Keepsake runs, but draws are
// refused. Only the reason is logged, never the key.
try {
  if (!sealingKey(cfg)) app.log.warn('no sealing key (KEEPSAKE_SEALING_KEY): draws are off until it is set');
} catch (e) {
  app.log.warn(`the sealing key is not usable (${e instanceof SealError ? e.message : 'it cannot be read'}): draws are off until it is fixed`);
}
const setupFile = ensureSetupLink(db, cfg);
if (setupFile) app.log.warn(`Keepsake needs its first admin: open the link in ${setupFile} (valid 24 hours, once)`);
await app.listen({ host: cfg.host, port: cfg.port });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
