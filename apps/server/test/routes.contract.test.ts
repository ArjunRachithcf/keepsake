// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec declares and
// a body that validates against the spec's schema for it.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';

interface Op { operationId: string; security?: unknown[]; responses: Record<string, { content?: Record<string, { schema: unknown }> }> }
const spec = parse(readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
const ops: { method: string; path: string; op: Op }[] = [];
for (const [path, item] of Object.entries<Record<string, Op | undefined>>(spec.paths)) {
  for (const m of METHODS) { const op = item[m]; if (op) ops.push({ method: m.toUpperCase(), path, op }); }
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(spec, 'openapi');
const pointer = (...parts: string[]) => 'openapi#/' + parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

describe.each(['standalone', 'homerslab'] as const)('contracts/openapi.yaml (%s)', (mode) => {
  let built: BuiltApp;
  beforeAll(async () => { built = await buildApp(loadConfig({ KEEPSAKE_MODE: mode })); await built.app.ready(); });
  afterAll(() => built.app.close());

  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    expect(built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(specRoutes);
  });

  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const res = await built.app.inject({ method: o.method as 'GET', url: `/api${o.path}` });
    const declared = o.op.responses[String(res.statusCode)];
    expect(declared, `status ${res.statusCode} is not declared`).toBeDefined();
    const schema = declared?.content?.['application/json'];
    if (schema) {
      const validate = ajv.getSchema(pointer('paths', o.path, o.method.toLowerCase(), 'responses', String(res.statusCode), 'content', 'application/json', 'schema'));
      const body = res.json();
      expect(validate?.(body), JSON.stringify(validate?.errors)).toBe(true);
      if (o.op.operationId === 'health') expect(body.mode).toBe(mode);
    }
  });

  it('only /health is open (deny by default from M1)', () => {
    expect(ops.filter((o) => Array.isArray(o.op.security) && o.op.security.length === 0).map((o) => o.op.operationId)).toEqual(['health']);
  });
});
