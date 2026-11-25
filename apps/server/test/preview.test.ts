// "Add from a link" (ADR 0011): a shop's page read as text for a wish's name and price, only from the shops the server
// lists, through the egress client; nothing stored. Pages here are strings and stand-in clients: nothing leaves.
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import * as t from '../src/db/schema';
import { EgressError, createEgress, type Egress } from '../src/net/egress';
import { minorUnits, plain, proposal, readPage } from '../src/wishes/preview';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

describe('reading a page', () => {
  it('a schema.org Product in JSON-LD first: its name, price and currency', () => {
    const html = `<html><head><title>Shop | Kite</title><meta property="og:title" content="Not this">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":["Product"],"name":"Dragon kite &amp; string","offers":[{"@type":"Offer","price":"34.90","priceCurrency":"CHF"}]}]}</script></head></html>`;
    expect(readPage(html)).toEqual({ name: 'Dragon kite &amp; string', amount: '34.90', currency: 'CHF' });
    expect(proposal('https://shop.test/k', readPage(html), 'CHF')).toEqual({ link: 'https://shop.test/k', name: 'Dragon kite & string', priceMinor: 3490, pagePrice: { currency: 'CHF', amountMinor: 3490 } });
  });

  it('then Open Graph and product meta tags, then the title', () => {
    const og = `<meta content="A wool scarf" property="og:title"><meta property='product:price:amount' content="1'299.00"><meta property="product:price:currency" content="eur">`;
    expect(proposal('l', readPage(og), 'CHF')).toEqual({ link: 'l', name: 'A wool scarf', priceMinor: null, pagePrice: { currency: 'EUR', amountMinor: 129900 } });
    expect(proposal('l', readPage('<title>\n  Hiking socks &#8211; 2 pairs\n</title>'), 'CHF')).toEqual({ link: 'l', name: 'Hiking socks – 2 pairs', priceMinor: null, pagePrice: null });
    expect(proposal('l', readPage('<p>nothing here</p>'), 'CHF')).toEqual({ link: 'l', name: null, priceMinor: null, pagePrice: null });
  });

  it('nothing in a page runs or carries through: control and format characters dropped, the name cut to 120', () => {
    expect(plain('A‮bidi​ kite\u0000\u0007 &lt;b&gt; &#x1F600; &#0; &#xD800;')).toBe('A bidi kite <b> 😀');
    const long = proposal('l', { name: 'x'.repeat(500), amount: null, currency: null }, null);
    expect(long.name).toHaveLength(120);
    // A script's text is not a name; a broken JSON-LD is skipped.
    const html = '<script>document.title="pwned"</script><script type="application/ld+json">{nope</script><title>Real</title>';
    expect(readPage(html).name).toBe('Real');
  });

  it.each([
    ['34.90', 'CHF', 3490], ['34,90', 'EUR', 3490], ['1,234.50', 'USD', 123450], ['1.234,50', 'EUR', 123450], ["1'234.50", 'CHF', 123450],
    ['25.–', 'CHF', 2500], ['CHF 25.00', 'CHF', 2500], ['12', 'CHF', 1200], ['1,234', 'USD', 123400], ['1500', 'JPY', 1500],
    ['-5', 'CHF', null], ['abc', 'CHF', null], ['1e9', 'CHF', null], ['99999999999', 'CHF', null], ['', 'CHF', null],
  ])('%s %s → %s', (amount, currency, want) => expect(minorUnits(amount, currency)).toBe(want));

  it('a price only in the household\'s currency becomes the wish\'s price; else only what the page says', () => {
    const f = { name: 'Kite', amount: '20', currency: 'EUR' };
    expect(proposal('l', f, 'EUR').priceMinor).toBe(2000);
    expect(proposal('l', f, 'CHF').priceMinor).toBeNull();
    expect(proposal('l', f, null).priceMinor).toBeNull();
    expect(proposal('l', { ...f, currency: 'euro' }, 'EUR').pagePrice).toBeNull();
  });
});

describe('POST /api/link-preview', () => {
  let built: BuiltApp | undefined;
  afterEach(async () => { await built?.app.close(); built = undefined; });
  const start = async (env: NodeJS.ProcessEnv, egress: Egress) => {
    const db = household();
    db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
    built = await buildApp(standalone(env), db, { egress });
    const before = JSON.stringify(db.select().from(t.wish).all());
    const post = (url: unknown, who = 'p_robin') => built!.app.inject({ method: 'POST', url: '/api/link-preview', payload: { url }, headers: { origin: ORIGIN, cookie: sessionCookie(db, who) } });
    return { db, post, unchanged: () => expect(JSON.stringify(db.select().from(t.wish).all())).toBe(before) };
  };
  const SHOP = { KEEPSAKE_EGRESS: 'on', KEEPSAKE_SHOP_HOSTS: 'shop.test' };
  const asked: string[] = [];
  const pageOf = (html: string): Egress => ({ request: async (url, rules) => { asked.push(`${rules.name} ${url}`); return { status: 200, type: 'text/html', body: Buffer.from(html), url }; } });

  it('reads the page and proposes, storing nothing; the link kept is the one given', async () => {
    asked.length = 0;
    const { post, unchanged } = await start(SHOP, pageOf('<meta property="og:title" content="A dragon kite"><meta property="og:price:amount" content="34.90"><meta property="og:price:currency" content="CHF">'));
    const r = await post('https://shop.test/kite?ref=1');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ link: 'https://shop.test/kite?ref=1', name: 'A dragon kite', priceMinor: 3490, pagePrice: { currency: 'CHF', amountMinor: 3490 } });
    expect(asked).toEqual(['shop https://shop.test/kite?ref=1']);
    unchanged();
  });

  it('off without a list of shops, or with egress off: nothing is fetched', async () => {
    asked.length = 0;
    for (const env of [{ KEEPSAKE_EGRESS: 'on' }, { KEEPSAKE_EGRESS: 'off', KEEPSAKE_SHOP_HOSTS: 'shop.test' }]) {
      const { post } = await start(env, pageOf('<title>x</title>'));
      const r = await post('https://shop.test/kite');
      expect(r.statusCode).toBe(409);
      await built!.app.close();
      built = undefined;
    }
    expect(asked.filter((a) => a.startsWith('shop')).length).toBeLessThanOrEqual(1);
  });

  it('every failure is one of the fixed refusals, never the page\'s words', async () => {
    const { post } = await start(SHOP, { request: async () => { throw new EgressError('status', 'shop.test answered 500: <h1>secret stack trace</h1>', 500); } });
    const r = await post('https://shop.test/kite');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'the page could not be read: type the wish instead' });
    const notListed = await start(SHOP, { request: async () => { throw new EgressError('not-allowed', 'evil.test is not on the list'); } });
    expect((await notListed.post('https://evil.test/kite')).json()).toEqual({ error: 'Keepsake reads pages only from the shops on its list: type the wish instead' });
    expect((await notListed.post('http://shop.test/kite')).json()).toEqual({ error: 'Keepsake reads pages only from the shops on its list: type the wish instead' });
    for (const bad of ['javascript:alert(1)', 'https://u:p@shop.test/', 'x'.repeat(3000), 42]) expect((await notListed.post(bad)).statusCode, String(bad)).toBe(400);
  });

  it('with the real client: a host not on the list is never resolved or connected to', async () => {
    const { post } = await start({ ...SHOP }, createEgress({
      resolve: async () => { throw new Error('must not resolve'); }, test: { plainPort: 1 },
    }));
    expect((await post('https://169.254.169.254/latest/meta-data/')).statusCode).toBe(409);
    expect((await post('https://localhost/')).statusCode).toBe(409);
    expect((await post('https://shop.test.evil.example/')).statusCode).toBe(409);
  });

  it('one at a time and 30 an hour per person; guests and strangers get nothing', async () => {
    let release: () => void = () => {};
    const slow: Egress = { request: (url) => new Promise((ok) => { release = () => ok({ status: 200, type: 'text/html', body: Buffer.from('<title>x</title>'), url }); }) };
    const { post, db } = await start(SHOP, slow);
    const first = post('https://shop.test/a');
    await new Promise((ok) => setTimeout(ok, 20));
    expect((await post('https://shop.test/b')).json()).toEqual({ error: 'too many pages read: wait a few minutes' });
    release();
    expect((await first).statusCode).toBe(200);
    const anon = await built!.app.inject({ method: 'POST', url: '/api/link-preview', payload: { url: 'https://shop.test/a' }, headers: { origin: ORIGIN } });
    expect(anon.statusCode).toBe(401);
    await built!.app.close();
    built = await buildApp(standalone(SHOP), db, { egress: pageOf('<title>x</title>') });
    const cookie = sessionCookie(db, 'p_sam');
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await built.app.inject({ method: 'POST', url: '/api/link-preview', payload: { url: 'https://shop.test/a' }, headers: { origin: ORIGIN, cookie } })).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(30);
    expect(codes.at(-1)).toBe(409);
  });
});
