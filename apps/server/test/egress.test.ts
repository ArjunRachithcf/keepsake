// The one HTTP client (ADR 0011) against hostile servers: local ones made by the test, reached as if they were the
// listed hosts (the test resolves every name to 127.0.0.1 and counts that as public, and plain http stands in for
// TLS: the tests have no certificate). Nothing in this file reaches the network.
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressError, LIMITS, PUSH_HOSTS, USER_AGENT, allowed, createEgress, isPublicAddress, type Rules } from '../src/net/egress';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let routes: Record<string, Handler> = {};
let seen: { host: string; url: string; method: string; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ host: String(req.headers.host), url: req.url ?? '', method: req.method ?? '', headers: req.headers });
    const h = routes[`${String(req.headers.host).split(':')[0]}${req.url}`];
    if (h) h(req, res); else { res.statusCode = 404; res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
const reset = (r: Record<string, Handler>) => { routes = r; seen = []; };

const SHOPS: Rules = { name: 'shop', hosts: ['shop.test', 'www.shop.test', 'other-shop.test'] };
const local = async () => [{ address: '127.0.0.1', family: 4 }];
const client = (o: { resolve?: typeof local; timeoutMs?: number; enabled?: boolean } = {}) =>
  createEgress({ resolve: o.resolve ?? local, timeoutMs: o.timeoutMs, enabled: o.enabled, test: { isPublic: () => true, plainPort: port } });
const page = (body = '<title>A kite</title>', type = 'text/html; charset=utf-8'): Handler => (_q, r) => { r.setHeader('content-type', type); r.end(body); };
const redirect = (to: string): Handler => (_q, r) => { r.statusCode = 302; r.setHeader('location', to); r.end(); };
const fails = async (p: Promise<unknown>, reason: EgressError['reason']) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected ${reason}`).toBeInstanceOf(EgressError);
  expect((e as EgressError).reason).toBe(reason);
  return e as EgressError;
};

describe('what may be reached', () => {
  it.each([
    ['93.184.215.14', true], ['2606:4700::1111', true], ['10.1.2.3', false], ['127.0.0.1', false], ['169.254.169.254', false],
    ['172.21.1.11', false], ['192.168.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false],
    ['198.51.100.11', false], ['203.0.113.11', false],
    ['::1', false], ['fe80::1', false], ['fd00::1', false], ['::ffff:10.0.0.1', false], ['::ffff:93.184.215.14', true], ['2001:db8::1', false],
    ['2002:a00:1::', false], ['3fff::1', false], ['2001:2::1', false], ['not an address', false],
  ])('%s public: %s', (a, want) => expect(isPublicAddress(a)).toBe(want));

  it.each([
    ['https://shop.test/x', true], ['https://shop.test:443/x', true], ['https://www.shop.test/x', true],
    ['http://shop.test/x', false], ['https://shop.test:8443/x', false], ['https://u:p@shop.test/x', false], ['https://evil.test/x', false],
    ['https://shop.test.evil.test/x', false], ['https://sub.shop.test/x', false], ['https://93.184.215.14/x', false], ['https://[::1]/x', false],
    ['ftp://shop.test/x', false],
  ])('%s allowed: %s', (u, want) => expect(allowed(new URL(u), SHOPS)).toBe(want));

  it('push services: the known ones, Microsoft\'s by pattern, nothing else', () => {
    const push = { name: 'push', hosts: PUSH_HOSTS };
    for (const u of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect(allowed(new URL(u), push), u).toBe(true);
    for (const u of ['https://notify.windows.com/x', 'https://a.b.notify.windows.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'http://fcm.googleapis.com/x', 'https://127.0.0.1/x']) expect(allowed(new URL(u), push), u).toBe(false);
  });

  it('a host not on the list, http, another port, credentials or an IP: refused before any lookup or connection', async () => {
    reset({});
    let looked = 0;
    const c = client({ resolve: async () => { looked++; return [{ address: '127.0.0.1', family: 4 }]; } });
    for (const u of ['https://evil.test/', 'http://shop.test/', 'https://shop.test:8080/', 'https://u:p@shop.test/', 'https://127.0.0.1/', 'not a url']) await fails(c.request(u, SHOPS, 'html'), 'not-allowed');
    await fails(client({ enabled: false }).request('https://shop.test/', SHOPS, 'html'), 'off');
    expect(looked).toBe(0);
    expect(seen).toEqual([]);
  });

  it('a host that resolves to a private address, or to a mix, is never connected to', async () => {
    reset({ 'shop.test/': page() });
    const strict = (answers: { address: string; family: number }[]) => createEgress({ resolve: async () => answers, test: { plainPort: port } });
    await fails(strict([{ address: '127.0.0.1', family: 4 }]).request('https://shop.test/', SHOPS, 'html'), 'private-address');
    await fails(strict([{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]).request('https://shop.test/', SHOPS, 'html'), 'private-address');
    await fails(strict([{ address: '::ffff:192.168.1.1', family: 6 }]).request('https://shop.test/', SHOPS, 'html'), 'private-address');
    await fails(strict([]).request('https://shop.test/', SHOPS, 'html'), 'network');
    expect(seen).toEqual([]);
  });

  it('the connection goes to the address that was checked, not to a second lookup', async () => {
    reset({ 'shop.test/': page() });
    let n = 0;
    // First answer public (the stand-in), any later one would be the router: there must be no later one.
    const r = await client({ resolve: async () => (n++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '192.168.1.1', family: 4 }]) }).request('https://shop.test/', SHOPS, 'html');
    expect(r.body.toString()).toBe('<title>A kite</title>');
    expect(n).toBe(1);
  });
});

describe('what comes back', () => {
  it('a page, with an honest User-Agent and nothing of the household: no cookie, no credentials, no referer, no compression', async () => {
    reset({ 'shop.test/kite': page() });
    const r = await client().request('https://shop.test/kite', SHOPS, 'html');
    expect(r).toMatchObject({ status: 200, type: 'text/html', url: 'https://shop.test/kite' });
    const h = seen[0]!.headers;
    expect(h['user-agent']).toBe(USER_AGENT);
    expect(h['accept-encoding']).toBe('identity');
    for (const k of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for']) expect(h[k], k).toBeUndefined();
  });

  it('redirects: to listed shops only (each checked again), at most 3, never to http, an IP or another host', async () => {
    reset({ 'shop.test/a': redirect('https://www.shop.test/b'), 'www.shop.test/b': redirect('/c'), 'www.shop.test/c': page() });
    expect((await client().request('https://shop.test/a', SHOPS, 'html')).url).toBe('https://www.shop.test/c');
    for (const to of ['https://evil.test/x', 'http://shop.test/x', 'https://127.0.0.1/x', 'https://shop.test:8443/x', 'https://u:p@shop.test/x']) {
      reset({ 'shop.test/a': redirect(to) });
      await fails(client().request('https://shop.test/a', SHOPS, 'html'), 'redirect');
      expect(seen.length, to).toBe(1);
    }
    reset({ 'shop.test/1': redirect('/2'), 'shop.test/2': redirect('/3'), 'shop.test/3': redirect('/4'), 'shop.test/4': redirect('/5'), 'shop.test/5': page() });
    await fails(client().request('https://shop.test/1', SHOPS, 'html'), 'redirect');
    // A redirect that resolves to a private address is refused like the first hop.
    reset({ 'shop.test/a': redirect('https://other-shop.test/b'), 'other-shop.test/b': page() });
    const c = createEgress({ resolve: async (h) => [{ address: h === 'other-shop.test' ? '10.0.0.5' : '127.0.0.1', family: 4 }], test: { plainPort: port, isPublic: (a) => a === '127.0.0.1' } });
    await fails(c.request('https://shop.test/a', SHOPS, 'html'), 'private-address');
  });

  it('too large: by its length, or as it arrives', async () => {
    const big = 'x'.repeat(LIMITS.html + 1);
    reset({ 'shop.test/a': page(big) });
    await fails(client().request('https://shop.test/a', SHOPS, 'html'), 'too-large');
    reset({ 'shop.test/b': (_q, r) => { r.setHeader('content-type', 'text/html'); r.write('x'.repeat(LIMITS.html)); r.end('xx'); } });
    await fails(client().request('https://shop.test/b', SHOPS, 'html'), 'too-large');
  });

  it('compressed, of another type, or not a 2xx: refused', async () => {
    reset({ 'shop.test/gz': (_q, r) => { r.setHeader('content-type', 'text/html'); r.setHeader('content-encoding', 'gzip'); r.end('x'); } });
    await fails(client().request('https://shop.test/gz', SHOPS, 'html'), 'encoding');
    for (const type of ['application/javascript', 'image/svg+xml', 'application/json', '']) {
      reset({ 'shop.test/t': page('x', type) });
      await fails(client().request('https://shop.test/t', SHOPS, 'html'), 'type');
    }
    reset({ 'shop.test/s': (_q, r) => { r.statusCode = 500; r.end(); } });
    expect((await fails(client().request('https://shop.test/s', SHOPS, 'html'), 'status')).status).toBe(500);
  });

  it('one deadline for everything: a slow page, a slow lookup', async () => {
    reset({ 'shop.test/slow': (_q, r) => { r.setHeader('content-type', 'text/html'); r.write('<p>'); } });
    await fails(client({ timeoutMs: 200 }).request('https://shop.test/slow', SHOPS, 'html'), 'timeout');
    await fails(client({ timeoutMs: 200, resolve: () => new Promise(() => {}) }).request('https://shop.test/', SHOPS, 'html'), 'timeout');
  });

  it('a push: POSTed as given, its answer\'s status; never a redirect followed', async () => {
    const push = { name: 'push', hosts: ['push.test'] };
    reset({ 'push.test/send/1': (q, r) => { let n = 0; q.on('data', (c: Buffer) => { n += c.length; }); q.on('end', () => { r.statusCode = 201; r.end(String(n)); }); } });
    const r = await client().request('https://push.test/send/1', push, 'push', { method: 'POST', body: Buffer.alloc(77), headers: { ttl: '60' } });
    expect(r.status).toBe(201);
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { 'content-length': '77', ttl: '60' } });
    reset({ 'push.test/send/2': redirect('https://push.test/elsewhere') });
    expect((await fails(client().request('https://push.test/send/2', push, 'push', { method: 'POST', body: Buffer.alloc(1) }), 'status')).status).toBe(302);
    expect(seen.length).toBe(1);
  });
});
