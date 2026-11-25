// The seams (ADR 0003, ADR 0006), on the source and at run time:
// - routes never touch the database: they get the data facade (src/data.ts), never a Db; they import only the facade,
//   the validators, errors and types; they cannot reach a query, the SQLite client, the raw reply or a hijack;
// - every /api answer below 400 with a body is one the view layer built (a frozen, flagged object), whatever form the
//   route tried to send instead (a string, a Buffer, a stream, a viewed answer with a field added);
// - a wish's link is never fetched: nothing in the server opens a connection.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataFor } from '../src/data';
import * as t from '../src/db/schema';
import { installSeam } from '../src/seam';
import { isViewed, publicView } from '../src/view/view';
import { household, standalone } from './helpers';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : files(p);
  return /\.(ts|tsx|mjs|js)$/.test(f) && !f.endsWith('.gen.ts') ? [p] : [];
});
const server = files(join(root, 'apps/server/src'));
const routes = files(join(root, 'apps/server/src/routes'));
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => relative(root, f);

/** What a route file may import: the facade, validators, errors, config and WebAuthn types, contracts, Fastify, ulid. */
const ALLOWED_IMPORT = /^(?:\.\.\/(?:data|validate|errors|config|version|auth\/webauthn)(?:\.[jt]s)?|@keepsake\/contracts|fastify|ulid)$/;
/** Ways around the facade and the view layer, each refused in a route file. */
const FORBIDDEN: [string, RegExp][] = [
  ['a database handle', /\bdb\b|\$client|\.query\.|\bprepare\(/],
  ['a raw reply or a hijack', /\breply\.raw\b|\.hijack\(|\.serializer\(|\breq\.raw\b/],
  ['bytes made by hand', /JSON\.stringify|\bBuffer\b|\bReadable\b|createReadStream|\.pipe\(/],
  ['an answer built by hand', /return\s+\{|=>\s*\(\s*\{|\.send\((?!\)|\s*view\(|\s*data\.view\()|Object\.assign\(/],
  ['a dynamic import or require', /\bimport\(|\brequire\(/],
];
const imports = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const code = (src: string) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('routes never touch rows (ADR 0003)', () => {
  it('there are routes to check, and app.ts registers none itself', () => {
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(/\b(?:api|app)\.(?:get|post|put|patch|delete|route)\(/.test(read(join(root, 'apps/server/src/app.ts')))).toBe(false);
  });

  it('a route file imports only the facade, the validators, errors and types', () => {
    const bad = routes.flatMap((f) => imports(read(f)).filter((i) => !ALLOWED_IMPORT.test(i)).map((i) => `${rel(f)}: ${i}`));
    expect(bad).toEqual([]);
  });

  it.each(FORBIDDEN)('no route uses %s', (_n, re) => {
    expect(routes.filter((f) => re.test(code(read(f)))).map(rel)).toEqual([]);
  });

  it('the rules catch each bypass the M1 review found', () => {
    const offends = (src: string) => imports(src).some((i) => !ALLOWED_IMPORT.test(i)) || FORBIDDEN.some(([, re]) => re.test(code(src)));
    for (const bad of [
      "app.get('/x', async () => JSON.stringify(await db.query.wish.findMany()));",
      "reply.type('application/json'); return Buffer.from(JSON.stringify(rows));",
      "const rows = data.x.$client.prepare('select * from wish').all();",
      "import * as t from '../db/schema.js';",
      "import { openDb } from '../db/open';",
      "import { wishesOf } from '../wishes/wishes';",
      "import { sql } from 'drizzle-orm';",
      'return Object.assign(view(req).household(), { extra: 1 });',
      'reply.raw.end(body);',
      'reply.hijack();',
      "return reply.send(Readable.from(['x']));",
      "const m = await import('../db/open');",
      'reply.code(201).send(row)',
    ]) expect(offends(bad), bad).toBe(true);
    for (const ok of ["import { isFresh, type Data } from '../data';", 'return reply.code(201).send(view(req).wish(w));', 'reply.code(204).send()', 'return view(req).home(data.listFor(req.query));']) {
      expect(offends(ok), ok).toBe(false);
    }
  });
});

describe('the seam at run time', () => {
  let app: FastifyInstance;
  const db = household();
  const data = dataFor(standalone(), db);
  const alex = data.people.get('p_alex');
  const rows = () => db.$client.prepare('select * from wish').all();
  beforeAll(async () => {
    app = Fastify();
    // Rogue routes behind the same seam the API uses: each tries a way past the view layer.
    await app.register(async (api) => {
      installSeam(api);
      api.get('/viewed', async () => data.view(alex).household());
      api.get('/string', async () => JSON.stringify(db.select().from(t.wish).all()));
      api.get('/buffer', async (_req, reply) => { void reply.type('application/json'); return Buffer.from(JSON.stringify(rows())); });
      api.get('/stream', async (_req, reply) => reply.type('application/json').send(Readable.from(['[{"id":"w_mia_slime"}]'])));
      api.get('/object', async () => ({ wishes: rows() }));
      api.get('/array', async () => rows());
      api.get('/added', async () => Object.assign(data.view(alex).household(), { secret: 'w_mia_slime' }));
      api.get('/nested', async () => { const h = data.view(alex).household(); (h.people as unknown[]).push({ id: 'w_mia_slime' }); return h; });
      api.get('/error-with-rows', async (_req, reply) => reply.code(404).send({ error: 'no', rows: rows() }));
      api.get('/empty', async (_req, reply) => reply.code(204).send());
    }, { prefix: '/api' });
    await app.ready();
  });
  afterAll(() => app.close());

  it('a viewed answer goes out', async () => {
    const r = await app.inject({ url: '/api/viewed' });
    expect(r.statusCode).toBe(200);
    expect(r.json().me.name).toBe('Alex');
  });
  it.each(['/api/string', '/api/buffer', '/api/stream', '/api/object', '/api/array', '/api/added', '/api/nested'])('%s is refused with a 500 and no rows', async (url) => {
    const r = await app.inject({ url });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'something went wrong' });
    expect(r.body).not.toContain('w_mia_slime');
  });
  it('an error answer carries `{ error }` only', async () => {
    const r = await app.inject({ url: '/api/error-with-rows' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('w_mia_slime');
    expect(r.json()).toEqual({ error: 'something went wrong' });
  });
  it('an empty answer is fine', async () => expect((await app.inject({ url: '/api/empty' })).statusCode).toBe(204));
  it('viewed answers are frozen all the way down; a copy is not viewed', () => {
    const h = data.view(alex).household();
    expect(isViewed(h)).toBe(true);
    expect(Object.isFrozen(h) && Object.isFrozen(h.people) && Object.isFrozen(h.people[0])).toBe(true);
    expect(isViewed({ ...h })).toBe(false);
    expect(isViewed(publicView.health({ mode: 'standalone' }, '0.0.0'))).toBe(true);
  });
});

describe('links are never fetched (spec §8)', () => {
  it('nothing in the server opens a connection: no fetch, http(s), tls or dgram client, no HTTP library', () => {
    expect(server.length).toBeGreaterThan(15);
    const re = /\bfetch\s*\(|from\s+['"](?:node:)?(?:http|https|tls|http2|dgram)['"]|require\(\s*['"](?:node:)?(?:http|https|net|tls)['"]|from\s+['"](?:undici|axios|got|node-fetch)['"]|import\(\s*['"](?:node:)?(?:http|https|net|tls)['"]/;
    expect(server.filter((f) => re.test(read(f))).map(rel)).toEqual([]);
    // node:net only for isIP (config.ts)
    for (const f of server.filter((x) => /from\s+['"](?:node:)?net['"]/.test(read(x)))) expect(read(f), rel(f)).toMatch(/import\s+\{\s*isIP\s*\}\s+from\s+['"]node:net['"]/);
  });
});
