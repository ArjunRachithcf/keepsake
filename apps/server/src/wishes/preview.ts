// "Add from a link" (ADR 0011): a shop's page read for a wish's name and price, through the one egress client.
//
// - Only the shops the household listed (KEEPSAKE_SHOP_HOSTS), https on 443, public addresses only, redirects only to
//   other listed shops, 1 MB, 10 s, no compression (net/egress.ts). Nothing at all when the list is empty.
// - The page is read as text: nothing in it runs (no DOM, no scripts, no styles), nothing it names is fetched (no
//   pictures, no links followed), so there is no decoder or renderer to attack. Only a few fields are taken from it:
//   the product's name and price from its JSON-LD (schema.org Product) or its meta tags (Open Graph), else its title.
// - Nothing is stored: the answer is a proposal the person reads, changes and saves as any typed wish (POST /wishes),
//   and the link they keep is the one they pasted.
import type { Egress } from '../net/egress';
import { EgressError } from '../net/egress';
import { Refused } from '../errors';

export interface Preview { link: string; name: string | null; priceMinor: number | null; pagePrice: { currency: string; amountMinor: number } | null }
interface Found { name: string | null; amount: string | null; currency: string | null }

const NAME_MAX = 120;
const MONEY = 100_000_000;
/** Currencies without minor units (ISO 4217): their amounts are whole. */
const NO_MINOR = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };
/** Entities decoded (the few names pages use, and numbers), then control, format and invisible characters dropped. */
export function plain(s: string): string {
  const decoded = s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return decoded.replace(/[\p{Cc}\p{Cf}ᅟᅠㅤﾠ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]{1,40})\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'=<>`]{1,2000}))/g)) out[m[1]!.toLowerCase()] ??= m[2] ?? m[3] ?? m[4] ?? '';
  return out;
};

/** A Product in a JSON-LD value, depth-first, bounded. */
function product(v: unknown, depth = 0, seen = { n: 0 }): Record<string, unknown> | null {
  if (depth > 6 || ++seen.n > 500 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const p = product(x, depth + 1, seen); if (p) return p; } return null; }
  const o = v as Record<string, unknown>;
  const type = o['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return o;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) { const p = product(o[k], depth + 1, seen); if (p) return p; }
  return null;
}
const scalar = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** At most this many tags of a kind are looked at, and a tag longer than this is skipped: a page cannot make the reading slow. */
const MAX_TAGS = 2000;
const MAX_TAG = 3000;
/**
 * The tags `<name …>` of a page, by plain scanning (no regular expression runs over the page itself, so no pattern can
 * be made to backtrack): each with where its content starts.
 */
function* tagsOf(page: string, lower: string, name: string): Generator<{ tag: string; end: number }> {
  let i = 0;
  for (let n = 0; n < MAX_TAGS; n++) {
    const at = lower.indexOf(`<${name}`, i);
    if (at < 0) return;
    const next = lower.charCodeAt(at + name.length + 1);
    const end = lower.indexOf('>', at);
    if (end < 0) return;
    i = end + 1;
    // <metadata> is not <meta>; a tag without its end in reach is skipped.
    if (!(next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x2f || next === 0x3e) || end - at > MAX_TAG) continue;
    yield { tag: page.slice(at, end + 1), end: end + 1 };
  }
}

/** What a page says of its product (exported for the tests: pages from files, never the network). */
export function readPage(html: string): Found {
  const page = html.slice(0, 1 << 20);
  const lower = page.toLowerCase();
  const found: Found = { name: null, amount: null, currency: null };
  for (const { tag, end } of tagsOf(page, lower, 'script')) {
    if ((attrs(tag).type ?? '').trim().toLowerCase() !== 'application/ld+json') continue;
    const close = lower.indexOf('</script', end);
    if (close < 0 || close - end > 100_000) continue;
    let p: Record<string, unknown> | null = null;
    try { p = product(JSON.parse(page.slice(end, close))); } catch { /* not JSON: ignored */ }
    if (!p) continue;
    found.name = scalar(p.name);
    const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    if (offers && typeof offers === 'object') {
      const o = offers as Record<string, unknown>;
      found.amount = scalar(o.price) ?? scalar(o.lowPrice);
      found.currency = scalar(o.priceCurrency);
    }
    break;
  }
  const meta: Record<string, string> = {};
  for (const { tag } of tagsOf(page, lower, 'meta')) {
    const a = attrs(tag);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined) meta[key] ??= a.content;
  }
  found.name ??= meta['og:title'] ?? meta['twitter:title'] ?? null;
  found.amount ??= meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta.price ?? null;
  found.currency ??= meta['product:price:currency'] ?? meta['og:price:currency'] ?? meta.pricecurrency ?? null;
  if (found.name === null) {
    const [t] = tagsOf(page, lower, 'title');
    const close = t ? lower.indexOf('</title', t.end) : -1;
    if (t && close >= 0 && close - t.end <= 2000) found.name = page.slice(t.end, close);
  }
  return found;
}

/** An amount as pages write it ("1234.5", "1'234.50", "1,234.50", "12,50", "CHF 25.–") in minor units, or null. */
export function minorUnits(amount: string, currency: string): number | null {
  let s = amount.replace(/[\s'\u2019\u00a0]/g, '').replace(/[.,]?[–-]+$/, '').replace(/^[A-Za-z$€£¥]+|[A-Za-z$€£¥]+$/g, '');
  if (!/^\d{1,12}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$/.test(s)) return null;
  // The last separator followed by one or two digits is the decimal one; every other separator groups thousands.
  const dec = /[.,](\d{1,2})$/.exec(s);
  const whole = (dec ? s.slice(0, dec.index) : s).replace(/[.,]/g, '');
  const frac = dec ? dec[1]!.padEnd(2, '0') : '00';
  s = `${whole}.${frac}`;
  const n = NO_MINOR.has(currency) ? Math.round(Number(s)) : Math.round(Number(s) * 100);
  return Number.isSafeInteger(n) && n >= 0 && n <= MONEY ? n : null;
}

/** The page's proposal: its name (cleaned, at most 120 characters) and price (in the household's currency only). */
export function proposal(link: string, f: Found, householdCurrency: string | null): Preview {
  const name = f.name ? plain(f.name).slice(0, NAME_MAX).trim() || null : null;
  const currency = f.currency ? plain(f.currency).toUpperCase() : null;
  const amountMinor = f.amount && currency && /^[A-Z]{3}$/.test(currency) ? minorUnits(plain(f.amount), currency) : null;
  const pagePrice = amountMinor !== null && currency ? { currency, amountMinor } : null;
  return { link, name, priceMinor: pagePrice && pagePrice.currency === householdCurrency ? pagePrice.amountMinor : null, pagePrice };
}

/** Reads a shop's page for a wish. Every failure is one of two refusals, never the page's own words. */
export async function previewLink(egress: Egress, shops: readonly string[], link: string, householdCurrency: string | null): Promise<Preview> {
  if (!shops.length) throw new Refused(409, 'adding from a link is off on this server: type the wish instead');
  let body: Buffer;
  try {
    body = (await egress.request(link, { name: 'shop', hosts: shops }, 'html')).body;
  } catch (e) {
    if (e instanceof EgressError && e.reason === 'not-allowed') throw new Refused(409, 'Keepsake reads pages only from the shops on its list: type the wish instead');
    throw new Refused(409, 'the page could not be read: type the wish instead');
  }
  return proposal(link, readPage(new TextDecoder('utf-8', { fatal: false }).decode(body)), householdCurrency);
}
