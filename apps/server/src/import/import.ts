// The one-time import of the household's sheet (spec §5, ADR 0005): an admin uploads the "Gift List" tab as CSV
// (Person, Item, Link, Priority, Status, Bought by, Price, Occasion, Notes). A dry run shows the plan: each name in the
// file matched to someone of the household or waiting to be mapped (or skipped), each occasion matched to a celebration
// or any time, Reserved, Bought and Given rows as claims (claimed, bought, given) by the household member named in
// "Bought by", or nobody's imported reservation (Gate surprise H2: a skipped Bought row would be missing from its
// person's list, which says it was bought). Applying
// makes everything in one transaction, or nothing. Nothing of the file is kept but the wishes and claims it made: no
// table holds it, no log gets it, and the plan names only what the admin needs to map.
//
// Spreadsheet formulas never come through: a cell that starts with =, +, -, @, a tab or a carriage return loses those
// characters (CSV injection, should anything be exported to a sheet again), links must be http(s) and prices numbers.
import { and, count, eq, inArray, max } from 'drizzle-orm';
import { ulid } from 'ulid';
import { asDb, type Db } from '../db/open';
import * as t from '../db/schema';
import { allCelebrations, peopleByCelebration } from '../celebrations/celebrations';
import { Refused } from '../errors';
import { currency, household, type Person } from '../household/people';
import { MAX_WISHES } from '../wishes/wishes';
import { givenFields } from '../gifts/gifts';
import { today } from '../celebrations/dates';

export const MAX_CSV = 512 * 1024; // characters; the contract says it
export const MAX_ROWS = 2000;
const MAX_COLUMNS = 40;
const MAX_CELL = 4000;

export interface ImportInput { csv: string; people: Record<string, string | null>; occasions: Record<string, string | null> }

export type SkipReason = 'no_person' | 'no_item' | 'bought' | 'person_skipped' | 'person_unmapped' | 'item_too_long' | 'list_full';
export type WarningKind = 'link_dropped' | 'price_dropped' | 'buyer_unknown' | 'not_in_celebration' | 'note_cut';
export interface Plan {
  rows: number;
  people: { name: string; personId: string | null; status: 'matched' | 'mapped' | 'skipped' | 'unmapped'; rows: number }[];
  occasions: { name: string; celebrationId: string | null; status: 'matched' | 'mapped' | 'any' | 'unmatched'; rows: number }[];
  buyers: { name: string; personId: string | null; rows: number }[];
  wishes: number; claims: number;
  skipped: { row: number; reason: SkipReason }[];
  warnings: { row: number; kind: WarningKind }[];
  ready: boolean;
}
interface NewWish { personId: string; name: string; link: string | null; priceMinor: number | null; note: string | null; mostWanted: boolean; celebrationId: string | null; buyer: string | null; state: 'claimed' | 'bought' | 'given' }
/** What the Status column says of a row: a claim in that state, or none. */
const CLAIM_STATES: Record<string, NewWish['state']> = { reserved: 'claimed', bought: 'bought', purchased: 'bought', given: 'given' };

const NOT_CSV = () => new Refused(400, 'the file is not a CSV the importer reads');

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF; a leading BOM is dropped. Bounded in rows, columns and cell size. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => { if (cell.length > MAX_CELL || row.length >= MAX_COLUMNS) throw NOT_CSV(); row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim())) rows.push(row); row = []; if (rows.length > MAX_ROWS + 1) throw new Refused(400, 'the file has more than 2000 rows'); };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') endCell();
    else if (c === '\n') endRow();
    else if (c === '\r') { if (text[i + 1] !== '\n') endRow(); }
    else cell += c;
  }
  if (quoted) throw NOT_CSV();
  if (cell || row.length) endRow();
  return rows;
}

/** A cell as text: formula starters gone (CSV injection), spaces trimmed. */
export const clean = (v: string | undefined) => (v ?? '').replace(/^[\s=+\-@\t\r]+/, '').trim();
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const ANY = new Set(['', 'any', 'any time', 'anytime', 'any occasion', 'none', '-']);

function money(v: string, digits: number): number | null {
  const s = v.replace(/[A-Za-z$€£¥₣\s'’]/g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  const minor = Math.round(Number(s) * 10 ** digits);
  return minor <= 100_000_000 ? minor : null;
}
function webLink(v: string): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.href.length <= 2000 ? u.href : null;
  } catch { return null; }
}

/** A Reserved row's buyer who is nobody here: the claim is an imported reservation. */
const IMPORTED = '\u0000imported';

/** The plan for a file, and the wishes it would make (the dry run shows the first; apply writes the second). */
function planOf(db: Db, i: ImportInput): { plan: Plan; make: NewWish[] } {
  const rows = parseCsv(i.csv);
  const head = (rows.shift() ?? []).map(key);
  const col = (name: string) => head.indexOf(name);
  const at = { person: col('person'), item: col('item'), link: col('link'), priority: col('priority'), status: col('status'), buyer: col('bought by'), price: col('price'), occasion: col('occasion'), notes: col('notes') };
  if (at.person < 0 || at.item < 0) throw new Refused(400, 'the file needs the columns Person and Item');
  const cell = (r: string[], k: keyof typeof at) => (at[k] < 0 ? '' : clean(r[at[k]]));

  const people = household(db);
  const byName = new Map<string, Person[]>();
  for (const p of people) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p]);
  const ids = new Map(people.map((p) => [p.id, p]));
  const mapped = new Map(Object.entries(i.people).map(([k, v]) => [key(k), v]));
  const resolve = (name: string): { personId: string | null; status: Plan['people'][number]['status'] } => {
    const k = key(name);
    if (mapped.has(k)) {
      const v = mapped.get(k)!;
      if (v === null) return { personId: null, status: 'skipped' };
      if (!ids.has(v)) throw new Refused(400, 'people: someone is not in the household');
      return { personId: v, status: 'mapped' };
    }
    const found = byName.get(k);
    return found?.length === 1 ? { personId: found[0]!.id, status: 'matched' } : { personId: null, status: 'unmapped' };
  };
  const cels = allCelebrations(db);
  const celIds = new Set(cels.map((c) => c.id));
  const celByName = new Map<string, string[]>();
  for (const c of cels) celByName.set(key(c.name), [...(celByName.get(key(c.name)) ?? []), c.id]);
  const occMapped = new Map(Object.entries(i.occasions).map(([k, v]) => [key(k), v]));
  const occasion = (name: string): { celebrationId: string | null; status: Plan['occasions'][number]['status'] } => {
    const k = key(name);
    if (occMapped.has(k)) {
      const v = occMapped.get(k)!;
      if (v !== null && !celIds.has(v)) throw new Refused(400, 'celebrationId: a celebration this person is part of, or null for any time');
      return { celebrationId: v, status: v === null ? 'any' : 'mapped' };
    }
    if (ANY.has(k)) return { celebrationId: null, status: 'any' };
    const found = celByName.get(k);
    return found?.length === 1 ? { celebrationId: found[0]!, status: 'matched' } : { celebrationId: null, status: 'unmatched' };
  };
  const inCelebration = peopleByCelebration(db);
  const digits = (() => { const c = currency(db); return c ? new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2 : null; })();
  const room = new Map<string, number>();
  const roomOf = (personId: string) => {
    if (!room.has(personId)) {
      const n = db.select({ n: count() }).from(t.wish).where(and(eq(t.wish.personId, personId), inArray(t.wish.state, ['listed', 'awaiting_parent']))).get()?.n ?? 0;
      room.set(personId, MAX_WISHES - n);
    }
    return room.get(personId)!;
  };

  const tally = <T extends { name: string; rows: number }>(m: Map<string, T>, name: string, make: () => Omit<T, 'name' | 'rows'>) => {
    const k = key(name);
    const e = m.get(k) ?? ({ name: name.trim(), rows: 0, ...make() } as T);
    e.rows++;
    m.set(k, e);
    return e;
  };
  const pm = new Map<string, Plan['people'][number]>();
  const om = new Map<string, Plan['occasions'][number]>();
  const bm = new Map<string, Plan['buyers'][number]>();
  const skipped: Plan['skipped'] = [];
  const warnings: Plan['warnings'] = [];
  const make: NewWish[] = [];
  rows.forEach((r, n) => {
    const row = n + 2; // the row in the sheet (its header is row 1)
    const name = cell(r, 'person');
    const item = cell(r, 'item');
    if (!name) return void skipped.push({ row, reason: 'no_person' });
    if (!item) return void skipped.push({ row, reason: 'no_item' });
    const who = tally(pm, name, () => resolve(name));
    const status = key(cell(r, 'status'));
    if (who.status === 'skipped') return void skipped.push({ row, reason: 'person_skipped' });
    if (!who.personId) return void skipped.push({ row, reason: 'person_unmapped' });
    if (item.length > 120) return void skipped.push({ row, reason: 'item_too_long' });
    if (roomOf(who.personId) <= 0) return void skipped.push({ row, reason: 'list_full' });
    room.set(who.personId, roomOf(who.personId) - 1);
    const occName = cell(r, 'occasion');
    const occ = tally(om, occName || 'Any time', () => occasion(occName));
    let celebrationId = occ.celebrationId;
    if (celebrationId && !inCelebration.get(celebrationId)?.includes(who.personId)) { celebrationId = null; warnings.push({ row, kind: 'not_in_celebration' }); }
    const rawLink = cell(r, 'link');
    const link = webLink(rawLink);
    if (rawLink && !link) warnings.push({ row, kind: 'link_dropped' });
    const rawPrice = cell(r, 'price');
    const priceMinor = rawPrice && digits !== null ? money(rawPrice, digits) : null;
    if (rawPrice && priceMinor === null) warnings.push({ row, kind: 'price_dropped' });
    let note = cell(r, 'notes') || null;
    if (note && note.length > 500) { note = note.slice(0, 500); warnings.push({ row, kind: 'note_cut' }); }
    // A Reserved row keeps its reservation: by its buyer when they are someone here who may give, otherwise as nobody's
    // "imported reservation" (review L1), so nobody buys it twice; an admin releases it if it was a mistake.
    let buyer: string | null = null;
    const state = CLAIM_STATES[status] ?? 'claimed';
    if (CLAIM_STATES[status]) {
      const by = cell(r, 'buyer');
      const b = by ? tally(bm, by, () => ({ personId: resolve(by).personId })) : null;
      const p = b?.personId ? ids.get(b.personId) : undefined;
      if (p && p.id !== who.personId && p.role !== 'kid') buyer = p.id;
      else { buyer = IMPORTED; warnings.push({ row, kind: 'buyer_unknown' }); }
    }
    const pr = key(cell(r, 'priority'));
    make.push({ personId: who.personId, name: item, link, priceMinor, note, mostWanted: /^(high|top|1|most wanted|must have|\*+|★+)$/.test(pr), celebrationId, buyer, state });
  });
  const plan: Plan = {
    rows: rows.length,
    people: [...pm.values()].sort((a, b) => a.name.localeCompare(b.name)),
    occasions: [...om.values()].sort((a, b) => a.name.localeCompare(b.name)),
    buyers: [...bm.values()].sort((a, b) => a.name.localeCompare(b.name)),
    wishes: make.length, claims: make.filter((w) => w.buyer).length,
    skipped: skipped.slice(0, 500), warnings: warnings.slice(0, 500),
    ready: ![...pm.values()].some((p) => p.status === 'unmapped'),
  };
  return { plan, make };
}

const adminOnly = (me: Person) => { if (me.role !== 'admin') throw new Refused(403, 'admins only'); };

/** The dry run: what applying would do. Nothing is written. */
export function dryRun(db: Db, me: Person, i: ImportInput): Plan {
  adminOnly(me);
  return planOf(db, i).plan;
}

/** Applies the plan in one transaction (every name mapped or skipped first). Returns what it made. */
export function applyImport(db: Db, me: Person, i: ImportInput, tz = 'UTC'): { wishes: number; claims: number; skipped: number } {
  adminOnly(me);
  return db.transaction((tx0) => {
    const tx = asDb(tx0);
    const { plan, make } = planOf(tx, i);
    if (!plan.ready) throw new Refused(409, 'map or skip every name in the file first');
    const now = new Date().toISOString();
    const next = new Map<string, number>();
    for (const w of make) {
      if (!next.has(w.personId)) next.set(w.personId, (tx.select({ p: max(t.wish.position) }).from(t.wish).where(eq(t.wish.personId, w.personId)).get()?.p ?? -1) + 1);
      const id = ulid();
      tx.insert(t.wish).values({
        id, personId: w.personId, celebrationId: w.celebrationId, name: w.name, link: w.link, priceMinor: w.priceMinor, quantity: 1, note: w.note,
        mostWanted: w.mostWanted ? 1 : 0, position: next.get(w.personId)!, state: 'listed', addedBy: w.personId, createdAt: now, updatedAt: now,
      }).run();
      next.set(w.personId, next.get(w.personId)! + 1);
      if (w.buyer) {
        const imported = w.buyer === IMPORTED;
        // A Given row is given today, so its reveal follows the usual rule (ADR 0003): after its occasion.
        const dates = w.state === 'given' ? givenFields(tx, tx.select().from(t.wish).where(eq(t.wish.id, id)).get()!, true, today(tz, new Date(now))) : {};
        tx.insert(t.claim).values({ id: ulid(), wishId: id, giverId: imported ? null : w.buyer, imported: imported ? 1 : 0, quantity: 1, state: w.state, ...dates, createdAt: now, updatedAt: now }).run();
      }
    }
    tx.insert(t.audit).values({ id: ulid(), at: now, actorId: me.id, action: 'imported', subjectId: ulid() }).run();
    return { wishes: plan.wishes, claims: plan.claims, skipped: plan.skipped.length };
  });
}
