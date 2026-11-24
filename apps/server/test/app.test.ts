import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { isApi } from '../src/paths';

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
  writeFileSync(join(web, 'assets', 'app.js'), 'export {};');
  afterAll(() => rmSync(web, { recursive: true, force: true }));

  it.each(['/api/health', '/', '/celebrations', '/api/nothing', '/api', '/api?x=1'])('%s carries them', async (url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
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
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(200);
    if (method === 'GET') expect(page(res)).toBe(true);
    await app.close();
  });

  it.each([
    ['POST', '/'], ['DELETE', '/celebrations'], ['PUT', '/family'], ['GET', '/api'], ['GET', '/api?x=1'], ['GET', '/api/nothing'],
    ['POST', '/api/health'], ['GET', '/api/health%00'], ['GET', '/assets/missing.js'],
  ] as const)('%s %s is a JSON 404, not the page', async (method, url) => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('serves the build\'s files', async () => {
    const { app } = await buildApp({ ...loadConfig({}), webDir: web });
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
