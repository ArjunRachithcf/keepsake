import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { isApi } from '../src/paths';
import { openDb } from '../src/db/open';

describe('config', () => {
  it('standalone binds to 127.0.0.1 by default', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('standalone');
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8080);
  });
  it('refuses an unknown mode, port, time zone or origin', () => {
    expect(() => loadConfig({ KEEPSAKE_MODE: 'open' })).toThrow(/KEEPSAKE_MODE/);
    expect(() => loadConfig({ KEEPSAKE_PORT: '80a' })).toThrow(/KEEPSAKE_PORT/);
    expect(() => loadConfig({ KEEPSAKE_TZ: 'Mars/Olympus' })).toThrow(/KEEPSAKE_TZ/);
    for (const o of ['http://keepsake.example.org', 'https://keepsake.example.org/path', 'https://user@keepsake.example.org', 'nonsense']) {
      expect(() => loadConfig({ KEEPSAKE_ORIGIN: o }), o).toThrow(/KEEPSAKE_ORIGIN/);
    }
  });
  it('standalone: the origin is localhost on the port unless set; the database is in the data folder', () => {
    const cfg = loadConfig({ KEEPSAKE_PORT: '9090', KEEPSAKE_DATA_DIR: '/data' });
    expect(cfg.origin).toBe('http://localhost:9090');
    expect(cfg.rpId).toBe('localhost');
    expect(cfg.dbFile).toBe('/data/keepsake.sqlite');
    expect(cfg.trustedProxy).toBeNull();
  });
});

describe('security headers', () => {
  const web = mkdtempSync(join(tmpdir(), 'keepsake-web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Keepsake</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'export {};');
  afterAll(() => rmSync(web, { recursive: true, force: true }));

  it.each(['/api/health', '/', '/celebrations', '/api/nothing', '/api', '/api?x=1'])('%s carries them', async (url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web }, openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    if (url.startsWith('/api')) expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  const page = (res: { statusCode: number; headers: Record<string, unknown>; body: string }) =>
    res.statusCode === 200 && String(res.headers['content-type']).startsWith('text/html') && res.body.includes('<title>Keepsake</title>');

  it.each([
    ['GET', '/'], ['GET', '/celebrations'], ['GET', '/family/someone'], ['HEAD', '/celebrations'],
  ] as const)('%s %s gets the page', async (method, url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web }, openDb(':memory:'));
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(200);
    if (method === 'GET') expect(page(res)).toBe(true);
    await app.close();
  });

  it.each([
    ['POST', '/'], ['DELETE', '/celebrations'], ['PUT', '/family'], ['GET', '/api'], ['GET', '/api?x=1'], ['GET', '/api/nothing'],
    ['POST', '/api/health'], ['GET', '/api/health%00'], ['GET', '/assets/missing.js'],
  ] as const)('%s %s is a JSON 404, not the page', async (method, url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web }, openDb(':memory:'));
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('serves the build\'s files', async () => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web }, openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('export {};');
    await app.close();
  });
});

describe('isApi', () => {
  it.each([['/api', true], ['/api?x=1', true], ['/api/health', true], ['/apix', false], ['/', false], ['/assets/a.js', false]] as const)('%s → %s', (url, want) => {
    expect(isApi(url)).toBe(want);
  });
});

describe('the data folder', () => {
  it('is for Keepsake\'s user only: the folder 0700, the database and its WAL 0600, whatever the umask', async () => {
    const { mkdtempSync, mkdirSync: mk, statSync, chmodSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const { tmpdir: tmp } = await import('node:os');
    const dir = j(mkdtempSync(j(tmp(), 'keepsake-mode-')), 'data');
    const old = process.umask(0o022);
    try {
      mk(dir);
      chmodSync(dir, 0o755);
      const db = openDb(j(dir, 'keepsake.sqlite'));
      db.$client.prepare('select 1').get();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const f of ['keepsake.sqlite', 'keepsake.sqlite-wal', 'keepsake.sqlite-shm']) expect(statSync(j(dir, f)).mode & 0o777, f).toBe(0o600);
      db.$client.close();
    } finally {
      process.umask(old);
    }
  });
});
