import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

describe('config', () => {
  it('standalone binds to 127.0.0.1 by default', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('standalone');
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8080);
  });
  it('refuses an unknown mode or port', () => {
    expect(() => loadConfig({ KEEPSAKE_MODE: 'open' })).toThrow(/KEEPSAKE_MODE/);
    expect(() => loadConfig({ KEEPSAKE_PORT: '80a' })).toThrow(/KEEPSAKE_PORT/);
  });
});

describe('security headers', () => {
  const web = mkdtempSync(join(tmpdir(), 'keepsake-web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Keepsake</title>');
  afterAll(() => rmSync(web, { recursive: true, force: true }));

  it.each(['/api/health', '/', '/celebrations', '/api/nothing'])('%s carries them', async (url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    if (url.startsWith('/api/')) expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('an unknown /api route is a JSON 404, not the page', async () => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
    const res = await app.inject({ method: 'GET', url: '/api/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });
});
