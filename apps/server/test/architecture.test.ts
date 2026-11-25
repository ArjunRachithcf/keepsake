// The seams (ADR 0003, ADR 0006), on the source and at run time:
// - route files get a narrow router (src/router.ts) and the data facade (src/data.ts), never Fastify or a Db; they
//   import only the facade, the validators, errors and types; nothing in them reaches a query, the SQLite client, the
//   socket, a raw stream, a reply, a hook or a serializer;
// - every /api answer below 400 with a body is byte for byte one the view layer built; redirects, error bodies outside
//   the catalogue and unknown headers are refused; routes the router did not make are refused at start-up;
// - a wish's link is never fetched: nothing in the server opens a connection.
// The seam guards against mistakes in our own code, not deliberately hostile code; these bans are the backstop.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataFor } from '../src/data';
import * as t from '../src/db/schema';
import { getPerson } from '../src/household/people';
import { routerFor, type Req } from '../src/router';
import { installSeam } from '../src/seam';
import { isViewed } from '../src/view/view';
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

/** What a route file may import: the facade, validators, errors, the version, contracts, ulid; and some types. */
const ALLOWED_IMPORT = /^(?:\.\.\/(?:data|validate|errors|version)(?:\.[jt]s)?|@keepsake\/contracts|ulid)$/;
/** Imported for their types only. */
const TYPE_ONLY = /^\.\.\/(?:router|config|auth\/webauthn)(?:\.[jt]s)?$/;
/** Ways around the facade, the router and the view layer, each refused in a route file. */
const FORBIDDEN: [string, RegExp][] = [
  ['a database handle', /\bdb\b|\$client|\.query\.|\bprepare\(/],
  ['the socket, a raw stream or a reply', /\.socket\b|\.raw\b|\bhijack\b|\breply\b|writeHead|\.write\(|\.end\(|\.redirect\(|\.header\(|\.headers\b/],
  ['Fastify itself', /\baddHook\b|\bregister\(|\bdecorate\w*\(|setErrorHandler|setNotFoundHandler|setReplySerializer|setSerializerCompiler|\.serializer\(|\.route\(|\bfastify\b/i],
  ['bytes made by hand', /JSON\.stringify|\bBuffer\b|\bReadable\b|createReadStream|\.pipe\(/],
  ['an answer built by hand', /return\s+\{|=>\s*\(\s*\{|\.send\(|Object\.assign\(/],
  ['a dynamic import or require', /\bimport\(|\brequire\(/],
];
/** Anywhere in the server: nothing writes to a raw stream or takes over a reply (the seam would never see it). */
const NOWHERE = /\.hijack\(|\breply\.raw\b|\bres\.raw\b|\.raw\.(?:write|end)\(|writeHead\(|socket\.(?:write|end|cork)\(/;
const importsOf = (src: string) => [...src.matchAll(/(?:^|\n)\s*(import|export)(\s+type)?\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => ({ from: m[3]!, typeOnly: Boolean(m[2]) }));
const badImports = (src: string) => importsOf(src).filter((i) => !ALLOWED_IMPORT.test(i.from) && !(TYPE_ONLY.test(i.from) && i.typeOnly)).map((i) => i.from);
const code = (src: string) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('routes never touch rows, Fastify or the reply (ADR 0003)', () => {
  it('there are routes to check, and app.ts registers none itself', () => {
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(/\b(?:api|app)\.(?:get|post|put|patch|delete|route)\(/.test(read(join(root, 'apps/server/src/app.ts')))).toBe(false);
  });

  it('a route file imports only the facade, the validators, errors and types', () => {
    expect(routes.flatMap((f) => badImports(read(f)).map((i) => `${rel(f)}: ${i}`))).toEqual([]);
  });

  it.each(FORBIDDEN)('no route uses %s', (_n, re) => {
    expect(routes.filter((f) => re.test(code(read(f)))).map(rel)).toEqual([]);
  });

  it('nothing in the server writes to a raw stream or hijacks a reply', () => {
    expect(server.filter((f) => NOWHERE.test(code(read(f)))).map(rel)).toEqual([]);
  });

  it('the rules catch each bypass the M1 reviews found', () => {
    const offends = (src: string) => badImports(src).length > 0 || FORBIDDEN.some(([, re]) => re.test(code(src)));
    for (const bad of [
      "app.get('/x', async () => JSON.stringify(await db.query.wish.findMany()));",
      "reply.type('application/json'); return Buffer.from(JSON.stringify(rows));",
      "const rows = data.x.$client.prepare('select * from wish').all();",
      "import * as t from '../db/schema.js';",
      "import { openDb } from '../db/open';",
      "import { wishesOf } from '../wishes/wishes';",
      "import { sql } from 'drizzle-orm';",
      "import type { FastifyInstance } from 'fastify';",
      "import { routerFor } from '../router';",
      "import { fastifyRequestOf } from '../router';",
      "import { isViewed } from '../view/view';",
      'return Object.assign(data.view(r).household(), { extra: 1 });',
      'reply.raw.end(body);',
      'reply.hijack();',
      "return reply.send(Readable.from(['x']));",
      "const m = await import('../db/open');",
      'req.socket.write(rows)',
      "api.addHook('preSerialization', async () => rows);",
      "app.setReplySerializer(() => '[]');",
      "app.decorateRequest('viewed', true);",
      "reply.redirect('/elsewhere?w=' + id);",
      "reply.header('x-wish', name);",
      "return { wishes: rows };",
    ]) expect(offends(bad), bad).toBe(true);
    for (const ok of [
      "import { MAX_WISHES, type Data } from '../data';",
      "import type { Req, Router } from '../router';",
      "api.get('/home', (r) => data.view(r).home(data.listFor(r.query)));",
      'res.created();',
      'return data.view(r).wish(r.params.wishId);',
    ]) expect(offends(ok), ok).toBe(false);
  });
});

describe('the seam at run time', () => {
  let app: FastifyInstance;
  const db = household();
  const data = dataFor(standalone(), db);
  const rows = () => db.$client.prepare('select * from wish').all();
  const LEAK = 'w_mia_slime';
  beforeAll(async () => {
    app = Fastify();
    // Rogue routes behind the same seam and router the API uses: each tries a way past the view layer. The viewer is
    // set by a plugin-level hook, as the auth hook does.
    await app.register(async (api) => {
      installSeam(api);
      api.addHook('onRequest', async (req) => {
        const who = typeof req.headers['x-who'] === 'string' ? req.headers['x-who'] : 'p_alex';
        req.caller = { person: getPerson(db, who)!, via: 'session' };
      });
      const r = routerFor(api, {});
      r.get('/capture', (q) => { captured = q; });
      // A cache of answers by page (a plausible shortcut): the first viewer's answer handed to the next one.
      const cache = new Map<string, unknown>();
      r.get('/cached/:personId', (q) => {
        const hit = cache.get(q.params.personId) ?? data.view(q).personPage(q.params.personId, null);
        cache.set(q.params.personId, hit);
        return hit as never;
      });
      // The facade checks the role itself, whatever the route forgot.
      r.post('/forgot-admin', (q) => { data.people.add(q, { name: 'Jordan', role: 'admin' }, false); });
      r.post('/forgot-admin-reset', (q) => { data.auth.resetPasskeys(q, 'p_sam'); });
      r.get('/viewed', (q) => data.view(q).household());
      r.get('/string', () => JSON.stringify(db.select().from(t.wish).all()) as never);
      r.get('/buffer', () => Buffer.from(JSON.stringify(rows())) as never);
      r.get('/stream', () => Readable.from([`[{"id":"${LEAK}"}]`]) as never);
      r.get('/object', () => ({ wishes: rows() }) as never);
      r.get('/array', () => rows() as never);
      r.get('/copy', (q) => ({ ...data.view(q).household(), secret: LEAK }) as never);
      r.get('/added', (q) => Object.assign(data.view(q).household(), { secret: LEAK }));
      r.get('/nested', (q) => { const h = data.view(q).household(); (h.people as unknown[]).push({ id: LEAK }); return h; });
      r.get('/forged-viewer', () => data.view({ params: {}, query: {}, body: {} } as Req).household());
      r.get('/empty', () => undefined);
      // Plugin-level hooks in the API's scope (route-level ones are refused at start): a header, a redirect, an error
      // body outside the catalogue.
      await api.register(async (sub) => {
        sub.addHook('preHandler', async (_req, reply) => { void reply.header('set-cookie', `other=${LEAK}`); });
        routerFor(sub, {}).get('/cookie', (q) => data.view(q).household());
      });
      await api.register(async (sub) => {
        sub.addHook('preHandler', async (_req, reply) => { void reply.header('x-wish', LEAK); });
        routerFor(sub, {}).get('/header', (q) => data.view(q).household());
      });
      await api.register(async (sub) => {
        sub.addHook('preHandler', async (_req, reply) => reply.redirect(`/elsewhere?w=${LEAK}`));
        routerFor(sub, {}).get('/redirect', (q) => data.view(q).household());
      });
      await api.register(async (sub) => {
        sub.addHook('preHandler', async (_req, reply) => reply.code(404).send({ error: LEAK }));
        routerFor(sub, {}).get('/error', (q) => data.view(q).household());
      });
      await api.register(async (sub) => {
        sub.addHook('preHandler', async (_req, reply) => reply.code(404).send({ error: 'not found', rows: rows() }));
        routerFor(sub, {}).get('/error-with-rows', (q) => data.view(q).household());
      });
      // An onSend added after the seam (an envelope, an ETag, compression): the guard still runs last.
      await api.register(async (sub) => {
        sub.addHook('onSend', async (_req, _reply, payload) => (typeof payload === 'string' ? payload.replace(/}$/, `,"x":"${LEAK}"}`) : payload));
        routerFor(sub, {}).get('/late-onsend', (q) => data.view(q).household());
      });
    }, { prefix: '/api' });
    await app.ready();
    await app.inject({ url: '/api/capture' });
  });
  afterAll(() => app.close());
  let captured: Req | undefined;
  const fakeReq = () => captured!;

  it('a viewed answer goes out', async () => {
    const r = await app.inject({ url: '/api/viewed' });
    expect(r.statusCode).toBe(200);
    expect(r.json().me.name).toBe('Alex');
  });
  it.each(['/api/string', '/api/buffer', '/api/stream', '/api/object', '/api/array', '/api/copy', '/api/added', '/api/nested',
    '/api/forged-viewer', '/api/late-onsend', '/api/header', '/api/cookie', '/api/redirect', '/api/error', '/api/error-with-rows'])('%s is refused with a 500 and leaks nothing', async (url) => {
    const r = await app.inject({ url });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'something went wrong' });
    expect(r.body).not.toContain(LEAK);
    expect(JSON.stringify(r.headers)).not.toContain(LEAK);
    expect(r.headers.location).toBeUndefined();
  });
  it('an answer built for another request is refused: a cached page never reaches the next viewer', async () => {
    const sam = await app.inject({ url: '/api/cached/p_mia', headers: { 'x-who': 'p_sam' } }); // Mia's parent: sees her waiting wish
    expect(sam.statusCode).toBe(200);
    expect(sam.body).toContain(LEAK);
    const robin = await app.inject({ url: '/api/cached/p_mia', headers: { 'x-who': 'p_robin' } });
    expect(robin.statusCode).toBe(500);
    expect(robin.body).not.toContain(LEAK);
  });

  it('the facade checks admin-only operations itself', async () => {
    for (const url of ['/api/forgot-admin', '/api/forgot-admin-reset']) {
      const r = await app.inject({ method: 'POST', url, headers: { 'x-who': 'p_robin' } });
      expect(r.statusCode, url).toBe(403);
    }
    expect(db.select().from(t.person).all().some((p) => p.name === 'Jordan')).toBe(false);
  });

  it('an empty answer is fine', async () => expect((await app.inject({ url: '/api/empty' })).statusCode).toBe(204));

  it('a route the router did not make is refused at start-up', async () => {
    const rogue = Fastify();
    const start = async () => {
      await rogue.register(async (api) => {
        installSeam(api);
        api.get('/rows', async () => rows());
      }, { prefix: '/api' });
      await rogue.ready();
    };
    await expect(start()).rejects.toThrow(/must come from the router/);
  });

  it('viewed answers are frozen all the way down; a copy is not viewed', async () => {
    const h = data.publicView(fakeReq()).signedIn('p_alex');
    expect(isViewed(h)).toBe(true);
    expect(Object.isFrozen(h) && Object.isFrozen(h.person)).toBe(true);
    expect(isViewed({ ...h })).toBe(false);
    expect(isViewed(data.publicView(fakeReq()).health('0.0.0'))).toBe(true);
  });

  it('the sign-in options keep only the fields the browser needs', () => {
    const o = { challenge: 'c', rpId: 'localhost', userVerification: 'required' as const, secret: LEAK, allowCredentials: [{ id: 'k', type: 'public-key' as const, extra: LEAK }] };
    const a = data.publicView(fakeReq()).signInStart('id', o);
    expect(JSON.stringify(a)).not.toContain(LEAK);
    expect(a.options).toEqual({ challenge: 'c', rpId: 'localhost', userVerification: 'required', allowCredentials: [{ id: 'k', type: 'public-key' }] });
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
