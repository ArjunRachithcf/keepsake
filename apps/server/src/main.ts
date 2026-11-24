import { buildApp } from './app';
import { loadConfig } from './config';

const cfg = loadConfig();
const { app } = await buildApp(cfg, { logger: true });
await app.listen({ host: cfg.host, port: cfg.port });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
