// The seams (ADR 0003, ADR 0006), checked on the source and at run time:
// - routes never touch database rows: no schema, no Drizzle, no SQLite in src/routes; they answer only with what the
//   view layer built (`view(...)`), and the API refuses with a 500 any answer below 400 that it did not build;
// - a wish's link is never fetched: nothing in the server opens a connection.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isViewed, publicView } from '../src/view/view';
import { viewGuard } from '../src/app';

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

describe('routes never serialize rows (ADR 0003)', () => {
  it('there are routes to check', () => expect(routes.length).toBeGreaterThanOrEqual(4));

  it('no route imports the schema, Drizzle or SQLite', () => {
    const re = /from\s+['"](?:\.\.\/db\/schema|drizzle-orm[^'"]*|better-sqlite3)['"]/;
    expect(routes.filter((f) => re.test(read(f))).map(rel)).toEqual([]);
  });

  it('no route returns or sends an object it built itself: only the view layer\'s answers', () => {
    // `return {`, `=> ({`, and `.send(` with anything but nothing or a view call.
    const re = /return\s+\{|=>\s*\(\s*\{|\.send\((?!\)|\s*view\(|\s*viewFor\()/;
    const hits = routes.flatMap((f) => read(f).split('\n').map((l, i) => [l, i] as const)
      .filter(([l]) => re.test(l) && !/\/\//.test(l.split(re)[0]!)).map(([l, i]) => `${rel(f)}:${i + 1}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  it('the rule catches what it should', () => {
    const re = /return\s+\{|=>\s*\(\s*\{|\.send\((?!\)|\s*view\(|\s*viewFor\()/;
    for (const bad of ['return { wish };', 'async () => ({ ok: true })', 'reply.code(201).send(row)', 'reply.send({ a: 1 })']) expect(re.test(bad), bad).toBe(true);
    for (const ok of ['return reply.code(201).send(view(req).wish(w));', 'reply.code(204).send()', 'return view(req).home(f);']) expect(re.test(ok), ok).toBe(false);
  });

  it('only the view layer marks answers; a plain object is refused at run time', async () => {
    expect(isViewed({ ok: true })).toBe(false);
    expect(isViewed(publicView.health({ mode: 'standalone' }, '0.0.0'))).toBe(true);
    const log = { error: () => undefined };
    const req = { log, routeOptions: { url: '/api/x' } } as never;
    await expect(viewGuard(req, { statusCode: 200 } as never, { id: 'w1', name: 'row' })).rejects.toThrow(/unviewed/);
    await expect(viewGuard(req, { statusCode: 200 } as never, [{ id: 'w1' }])).rejects.toThrow(/unviewed/);
    await expect(viewGuard(req, { statusCode: 404 } as never, { error: 'no such wish' })).resolves.toEqual({ error: 'no such wish' });
    const ok = publicView.health({ mode: 'standalone' }, '0.0.0');
    await expect(viewGuard(req, { statusCode: 200 } as never, ok)).resolves.toBe(ok);
    // `answer` (the marker) is the view module's own: nobody else imports it.
    expect(server.filter((f) => !f.endsWith('view/view.ts') && /\banswer\s*\(/.test(read(f)) && /from\s+['"][^'"]*view\/view['"]/.test(read(f)) && /\{[^}]*\banswer\b[^}]*\}\s*from/.test(read(f))).map(rel)).toEqual([]);
  });
});

describe('links are never fetched (spec §8)', () => {
  it('nothing in the server opens a connection: no fetch, http(s), net, tls or dgram client, no HTTP library', () => {
    expect(server.length).toBeGreaterThan(15);
    const re = /\bfetch\s*\(|from\s+['"](?:node:)?(?:http|https|net|tls|http2|dgram)['"]|require\(\s*['"](?:node:)?(?:http|https|net|tls)['"]|from\s+['"](?:undici|axios|got|node-fetch)['"]|import\(\s*['"](?:node:)?(?:http|https|net|tls)['"]/;
    expect(server.filter((f) => re.test(read(f))).map(rel)).toEqual([]);
  });
});
