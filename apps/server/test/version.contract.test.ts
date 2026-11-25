// The version is written in several places (package.json files, the OpenAPI spec, the HomersLab manifest, compose's
// default tag); they must all say apps/server/package.json's.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('one version everywhere', () => {
  it.each(['apps/server/package.json', 'apps/web/package.json', 'packages/contracts/package.json', 'packages/draw/package.json'])('%s', (p) => {
    expect(JSON.parse(read(p)).version).toBe(VERSION);
  });
  it('contracts/openapi.yaml', () => expect(parse(read('contracts/openapi.yaml')).info.version).toBe(VERSION));
  it('contracts/homerslab-app.yaml (version and image tag)', () => {
    const m = parse(read('contracts/homerslab-app.yaml'));
    expect(m.version).toBe(VERSION);
    expect(m.image).toMatch(new RegExp(`:${VERSION.replace(/\./g, '\\.')}@`));
  });
  it('docker-compose.yml default tag', () => expect(read('docker-compose.yml')).toContain(`keepsake:${VERSION}}`));
});
