// Shared by the API tests: contracts/openapi.yaml, a validator for it, sample requests, and a small invented
// household (fictional names only).
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { expect } from 'vitest';
import { createSession } from '../src/auth/sessions';
import type { WebAuthn } from '../src/auth/webauthn';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { nextDate } from '../src/celebrations/dates';

export const ORIGIN = 'http://localhost:8080';
/** The tests' sealing key (made up for them; never a real one). */
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
export const standalone = (env: NodeJS.ProcessEnv = {}) => loadConfig({ KEEPSAKE_MODE: 'standalone', KEEPSAKE_DATA_DIR: '/nonexistent', KEEPSAKE_SEALING_KEY: TEST_KEY, ...env });
export const homerslab = (proxy = '127.0.0.1', env: NodeJS.ProcessEnv = {}) => loadConfig({
  KEEPSAKE_MODE: 'homerslab', KEEPSAKE_EDGE_IDENTITY: 'homerslab-v1', KEEPSAKE_TRUSTED_PROXY: proxy, KEEPSAKE_ORIGIN: ORIGIN, KEEPSAKE_DATA_DIR: '/nonexistent',
  KEEPSAKE_SEALING_KEY: TEST_KEY, ...env,
});

export interface Schema { type?: string | string[]; enum?: unknown[]; pattern?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string; allOf?: Schema[]; anyOf?: Schema[]; minItems?: number }
export interface Op { operationId: string; security?: Record<string, string[]>[]; parameters?: Param[]; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, { $ref?: string; content?: Record<string, { schema: Schema }> }> }
export interface Param { $ref?: string; name: string; in: string; schema: Schema }

export const spec = parse(readFileSync(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'));
const deref = <T>(x: T & { $ref?: string }): T => (x.$ref ? deref(x.$ref.replace(/^#\//, '').split('/').reduce<any>((o, k) => o[k], spec)) : x); // eslint-disable-line @typescript-eslint/no-explicit-any
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;
export const ops: { method: string; path: string; op: Op; params: Param[] }[] = [];
for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const m of METHODS) {
    const op = item[m] as Op | undefined;
    if (op) ops.push({ method: m.toUpperCase(), path, op, params: [...((item.parameters as Param[]) ?? []), ...(op.parameters ?? [])].map(deref) });
  }
}
export type SpecOp = (typeof ops)[number];

export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(spec, 'openapi');
export const pointer = (...parts: string[]) => 'openapi#/' + parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

/** A small value that satisfies the schema (required properties only). */
export function sample(s0: Schema): unknown {
  const s = deref(s0);
  if (s.allOf) return Object.assign({}, ...s.allOf.map(sample));
  if (s.anyOf) return sample(s.anyOf[0]!);
  if (s.enum) return s.enum[0];
  if (s.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return '2026-12-24';
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return Object.fromEntries((s.required ?? []).map((k) => [k, sample(s.properties?.[k] ?? {})]));
    default: return 'x';
  }
}

export const security = (o: { op: Op }) => (o.op.security ?? spec.security) as Record<string, string[]>[];
export const isPublic = (o: { op: Op }) => security(o).length === 0;

/** Path parameters naming something real in household() that the admin may act on. */
const PARAMS: Record<string, Record<string, string>> = {
  getPerson: { personId: 'p_sam' }, editPerson: { personId: 'p_robin' }, removePerson: { personId: 'p_gone' },
  setManagers: { personId: 'p_mia' }, invitePerson: { personId: 'p_robin' }, setProfile: { personId: 'p_alex' },
  setWishOrder: { personId: 'p_alex' },
  editWish: { wishId: 'w_alex_tent' }, removeWish: { wishId: 'w_alex_old' },
  approveWish: { wishId: 'w_leo_kite' }, declineWish: { wishId: 'w_sug_for_alex' },
  removePasskey: { passkeyId: 'pk2' }, endSessions: { personId: 'p_mia' }, resetPasskeys: { personId: 'p_leo' },
  claimWish: { wishId: 'w_sam_book' }, editClaim: { wishId: 'w_sam_book' }, unclaimWish: { wishId: 'w_sam_book' },
  nameOnGift: { wishId: 'w_robin_scarf' },
  startGroupGift: { wishId: 'w_mia_bike' }, editGroupGift: { wishId: 'w_mia_bike' }, endGroupGift: { wishId: 'w_mia_bike' },
  chipIn: { wishId: 'w_sam_pan' }, withdrawShare: { wishId: 'w_sam_pan' },
  getCelebration: { celebrationId: 'c_xmas' }, editCelebration: { celebrationId: 'c_xmas' }, removeCelebration: { celebrationId: 'c_old' },
  // withDraws(): Christmas has a draw (Alex hosts it; Alex, Sam, Robin, Mia); the cousins' exchange has none yet
  getDraw: { celebrationId: 'c_xmas' }, createDraw: { celebrationId: 'c_cousins' }, editDraw: { celebrationId: 'c_xmas' },
  removeDraw: { celebrationId: 'c_cousins' }, runDraw: { celebrationId: 'c_xmas' }, openDraw: { celebrationId: 'c_xmas' },
};

/** Bodies that name something real where a bare sample would be refused. */
const BODIES: Record<string, unknown> = {
  addPerson: { name: 'Jordan', role: 'adult' },
  editHousehold: { currency: 'CHF' },
  setManagers: { managerIds: ['p_sam'] },
  addWish: { personId: 'p_alex', name: 'A rain jacket', celebrationId: 'c_xmas' },
  editWish: { note: 'Size M' },
  setWishOrder: { wishIds: ['w_alex_old', 'w_alex_tent'] },
  addCelebration: { name: 'Summer party', date: '2027-07-01', poster: 'gold', recurrence: 'none', people: ['p_alex'] },
  editCelebration: { place: 'The garden' },
  setProfile: { likes: ['Hiking'] },
  claimWish: { quantity: 1 },
  editClaim: { state: 'bought' },
  nameOnGift: { named: true },
  startGroupGift: { targetMinor: 12000 },
  editGroupGift: { targetMinor: 15000 },
  chipIn: { amountMinor: 2500 },
  createDraw: { people: ['p_alex', 'p_sam', 'p_robin'], budgetMinor: null },
  editDraw: { drawTogetherAt: null },
};

export function request(o: SpecOp) {
  let url = '/api' + o.path;
  for (const p of o.params) {
    if (p.in !== 'path') continue;
    url = url.replace(`{${p.name}}`, encodeURIComponent(PARAMS[o.op.operationId]?.[p.name] ?? 'x'));
  }
  const content = o.op.requestBody?.content ?? {};
  let payload: string | undefined;
  const headers: Record<string, string> = { origin: ORIGIN };
  if (content['application/json']) {
    payload = JSON.stringify(BODIES[o.op.operationId] ?? sample(content['application/json'].schema));
    headers['content-type'] = 'application/json';
  }
  return { method: o.method as 'GET', url, payload, headers };
}

/** The body validates against what the spec declares for this operation and status. */
export function expectValid(o: SpecOp, status: number, body: unknown) {
  const r = o.op.responses[String(status)];
  expect(r, `${o.op.operationId} declares ${status}`).toBeDefined();
  let ptr: string | null = null;
  if (r!.$ref) {
    const name = r!.$ref.split('/').pop()!;
    if (spec.components.responses[name].content?.['application/json']) ptr = pointer('components', 'responses', name, 'content', 'application/json', 'schema');
  } else if (r!.content?.['application/json']) {
    ptr = pointer('paths', o.path, o.method.toLowerCase(), 'responses', String(status), 'content', 'application/json', 'schema');
  }
  if (!ptr) return;
  const validate = ajv.getSchema(ptr)!;
  expect(validate(body), `${o.op.operationId} ${status}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const NOW = '2026-11-01T10:00:00.000Z';

/**
 * Alex (admin, two passkeys), Sam and Robin (adults), Mia (kid; Sam manages her), Leo (kid; nobody set, so the admins),
 * Pat (to be removed). Celebrations: Christmas (yearly; everyone), Mia's birthday (yearly; Mia), an old one-off.
 * Wishes in every state; Robin's scarf given by Alex last Christmas (over), Sam's pan a group gift Alex started.
 * All invented.
 */
export function household(): Db {
  const db = openDb(':memory:');
  db.insert(t.person).values([
    { id: 'p_alex', externalId: 'hl-alex', name: 'Alex', role: 'admin', createdAt: NOW },
    { id: 'p_sam', externalId: 'hl-sam', name: 'Sam', role: 'adult', createdAt: NOW },
    { id: 'p_robin', externalId: 'hl-robin', name: 'Robin', role: 'adult', createdAt: NOW },
    { id: 'p_mia', externalId: 'hl-mia', name: 'Mia', role: 'kid', createdAt: NOW },
    { id: 'p_leo', externalId: 'hl-leo', name: 'Leo', role: 'kid', createdAt: NOW },
    { id: 'p_gone', name: 'Pat', role: 'adult', createdAt: NOW },
  ]).run();
  db.insert(t.manager).values({ kidId: 'p_mia', managerId: 'p_sam' }).run();
  for (const [id, label] of [['pk1', 'Laptop'], ['pk2', 'Phone']] as const) db.insert(t.passkey).values({ id, personId: 'p_alex', publicKey: Buffer.from([1]), label, createdAt: NOW }).run();
  db.insert(t.celebration).values([
    { id: 'c_xmas', name: 'Christmas', date: '2024-12-24', poster: 'pine', recurrence: 'yearly', hostId: 'p_alex', createdAt: NOW },
    { id: 'c_mia', name: 'Mia\'s birthday', date: '2019-03-14', poster: 'berry', recurrence: 'yearly', hostId: 'p_sam', createdAt: NOW },
    { id: 'c_old', name: 'Old exchange', date: '2020-01-01', poster: 'night', recurrence: 'none', hostId: 'p_alex', createdAt: NOW },
  ]).run();
  for (const p of ['p_alex', 'p_sam', 'p_robin', 'p_mia', 'p_leo']) db.insert(t.celebrationPerson).values({ celebrationId: 'c_xmas', personId: p }).run();
  db.insert(t.celebrationPerson).values([{ celebrationId: 'c_mia', personId: 'p_mia' }, { celebrationId: 'c_old', personId: 'p_alex' }]).run();
  const w = (id: string, personId: string, name: string, state: 'listed' | 'awaiting_parent' | 'suggested', o: Partial<typeof t.wish.$inferInsert> = {}) =>
    ({ id, personId, name, state, position: 0, addedBy: personId, createdAt: NOW, updatedAt: NOW, celebrationId: null, ...o });
  db.insert(t.wish).values([
    w('w_alex_tent', 'p_alex', 'A two-person tent', 'listed', { celebrationId: 'c_xmas', mostWanted: 1 }),
    w('w_alex_old', 'p_alex', 'Hiking socks', 'listed', { position: 1 }),
    w('w_sam_book', 'p_sam', 'A cookbook', 'listed', { celebrationId: 'c_xmas' }),
    w('w_mia_bike', 'p_mia', 'A red bike', 'listed', { celebrationId: 'c_mia' }),
    w('w_mia_slime', 'p_mia', 'Glitter slime kit', 'awaiting_parent', { celebrationId: 'c_xmas', position: 1 }),
    w('w_leo_kite', 'p_leo', 'A dragon kite', 'awaiting_parent'),
    w('w_sug_for_alex', 'p_alex', 'A bread course', 'suggested', { addedBy: 'p_robin', position: 2 }),
    w('w_sug_for_mia', 'p_mia', 'A paint set', 'suggested', { addedBy: 'p_robin', position: 2 }),
    w('w_robin_scarf', 'p_robin', 'A wool scarf', 'listed'),
    w('w_sam_pan', 'p_sam', 'A cast-iron pan', 'listed', { position: 1 }),
  ]).run();
  db.insert(t.claim).values({ id: 'cl_scarf', wishId: 'w_robin_scarf', giverId: 'p_alex', quantity: 1, state: 'given', givenOn: '2025-12-24', createdAt: NOW, updatedAt: NOW }).run();
  db.insert(t.groupGift).values({ wishId: 'w_sam_pan', organizerId: 'p_alex', targetMinor: 8000, state: 'open', createdAt: NOW, updatedAt: NOW }).run();
  return db;
}

/** The household's day `n` days from today (UTC, the tests' household time zone). */
export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * household() plus draws: Christmas has one (hosted by Alex; Alex, Sam, Robin and, kids drawing too, Mia; not drawn yet), and a cousins'
 * exchange in ten days (Alex hosts; Alex, Sam, Robin) has none.
 */
export function withDraws(db: Db): Db {
  db.insert(t.celebration).values({ id: 'c_cousins', name: 'Cousins\' exchange', date: inDays(10), poster: 'gold', recurrence: 'none', hostId: 'p_alex', createdAt: NOW }).run();
  for (const p of ['p_alex', 'p_sam', 'p_robin']) db.insert(t.celebrationPerson).values({ celebrationId: 'c_cousins', personId: p }).run();
  const year = Number(nextDate('2024-12-24', 'yearly', inDays(0)).slice(0, 4));
  db.insert(t.draw).values({ id: 'd_xmas', celebrationId: 'c_xmas', year, rulesVersion: 1, kidsDraw: 1, createdBy: 'p_alex', createdAt: NOW, updatedAt: NOW }).run();
  for (const p of ['alex', 'sam', 'robin', 'mia']) db.insert(t.drawParticipant).values({ id: `dp_${p}`, drawId: 'd_xmas', kind: 'person', personId: `p_${p}`, createdAt: NOW }).run();
  return db;
}

export function sessionCookie(db: Db, personId: string): string {
  return `keepsake_session=${createSession(db, personId).token}`;
}

/** The X-HomersLab-* headers the edge would send for someone of household(). */
export const hl = (id: string, name: string, role: string) => ({ 'x-homerslab-person': id, 'x-homerslab-name': name, 'x-homerslab-role': role });

/**
 * A stand-in authenticator: a "response" is { id, challenge } and verifies when the challenge is the one issued.
 * The real verification is @simplewebauthn's.
 */
export function fakeWebAuthn(): WebAuthn {
  const challenge = () => randomBytes(16).toString('base64url');
  return {
    async registrationOptions({ userId, userName }) {
      const c = challenge();
      return { challenge: c, options: { challenge: c, rp: { name: 'Keepsake', id: 'localhost' }, user: { id: userId, name: userName, displayName: userName }, pubKeyCredParams: [{ alg: -7, type: 'public-key' }] } };
    },
    async verifyRegistration({ response, challenge: c }) {
      const r = response as { id?: string; challenge?: string } | undefined;
      return r?.challenge === c && r.id ? { id: r.id, publicKey: new Uint8Array([9]), counter: 0, transports: ['internal'], backedUp: true } : null;
    },
    async authenticationOptions() { const c = challenge(); return { challenge: c, options: { challenge: c, rpId: 'localhost', userVerification: 'required' } }; },
    credentialId(response) { const id = (response as { id?: unknown } | undefined)?.id; return typeof id === 'string' ? id : null; },
    async verifyAuthentication({ response, challenge: c, credential }) {
      const r = response as { id?: string; challenge?: string } | undefined;
      return r?.challenge === c && r.id === credential.id ? { newCounter: credential.counter + 1 } : null;
    },
  };
}
