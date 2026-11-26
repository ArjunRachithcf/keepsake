// Shared by M4's tests (questions, ideas, guests): a household with two extra grown-ups (Quinn, Uma) who are in no
// celebration and have no wishes, guests by link with fixed ids and tokens (so twin households match), and every
// reading answer of every viewer, bodies and headers. Fictional names only.
import { expect, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { hashToken } from '../src/auth/tokens';
import { today } from '../src/celebrations/dates';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { startGuestSession } from '../src/guests/guests';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

export const PEOPLE = ['alex', 'sam', 'robin', 'mia', 'leo', 'quinn', 'uma'] as const;
export type Who = (typeof PEOPLE)[number];
/** Guests: Robin's share links (gR, gR2, made by Alex), Mia's (gM, made by Sam, her parent), each with a name given. */
export const GUESTS = { gR: 'p_robin', gR2: 'p_robin', gM: 'p_mia' } as const;
export type Guest = keyof typeof GUESTS;
const NOW = '2026-11-01T10:00:00.000Z';
export const tokenOf = (g: string) => g.padEnd(43, 'x');

export interface Home { db: Db; built: BuiltApp; cookies: Record<string, string>; pushes: Map<string, number> }

/**
 * Every person has a device subscribed to Web Push, and pushes are counted by person instead of sent (ADR 0010): a
 * push, or none, must not depend on what is hidden from whoever gets it either.
 */
export function withDevices(db: Db): Map<string, number> {
  const pushes = new Map<string, number>();
  for (const p of db.select({ id: t.person.id }).from(t.person).all()) {
    db.insert(t.pushSubscription).values({ id: `ps_${p.id}`, personId: p.id, endpoint: `https://fcm.googleapis.com/fcm/send/${p.id}`, p256dh: 'x', auth: 'x', createdAt: NOW, confirmedAt: new Date().toISOString() }).run();
  }
  return pushes;
}
export const countingTransport = (pushes: Map<string, number>) => async (s: { personId: string }) => { pushes.set(s.personId, (pushes.get(s.personId) ?? 0) + 1); return 201; };

export async function makeHome(env: NodeJS.ProcessEnv = {}, opts: Parameters<typeof buildApp>[2] = {}): Promise<Home> {
  const db = household();
  db.insert(t.person).values([
    { id: 'p_quinn', name: 'Quinn', role: 'adult', createdAt: NOW },
    { id: 'p_uma', name: 'Uma', role: 'adult', createdAt: NOW },
  ]).run();
  db.insert(t.setting).values({ key: 'currency', value: 'CHF' }).run();
  db.insert(t.guestLink).values(Object.entries(GUESTS).map(([g, personId]) => ({
    id: `l_${g}`, kind: 'share' as const, personId, label: `Guest ${g}`, guestName: `Guest ${g}`, tokenHash: hashToken(tokenOf(g)),
    createdBy: personId === 'p_mia' ? 'p_sam' : 'p_alex', approvedAt: NOW, createdAt: NOW,
  }))).run();
  const cookies: Record<string, string> = Object.fromEntries(PEOPLE.map((p) => [p, sessionCookie(db, `p_${p}`)]));
  // Each guest on their own device (a browser of their own).
  for (const g of Object.keys(GUESTS)) cookies[g] = `__Host-keepsake_guest=${startGuestSession(db, tokenOf(g), today('UTC')).device}`;
  const pushes = withDevices(db);
  const built = await buildApp(standalone(env), db, { pushTransport: countingTransport(pushes), ...opts });
  return { db, built, cookies, pushes };
}

/** A guest's requests name their link (X-Keepsake-Link), as the guest page does. */
const linkOf = (who: string): Record<string, string> => (who in GUESTS ? { 'x-keepsake-link': `l_${who}` } : {});
export const as = (h: Home, who: Who | Guest) => ({
  get: (url: string) => h.built.app.inject({ url, headers: { cookie: h.cookies[who]!, ...linkOf(who) } }),
  send: (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    h.built.app.inject({ method, url, payload, headers: { cookie: h.cookies[who]!, origin: ORIGIN, ...linkOf(who) } }),
});

export const READS = ['/api/notices', '/api/push', '/api/home', '/api/home?for=c_xmas', '/api/celebrations', '/api/celebrations/c_xmas', '/api/celebrations/c_mia', '/api/auth/session',
  '/api/household', '/api/links', ...['alex', 'sam', 'robin', 'mia', 'leo', 'quinn', 'uma'].flatMap((p) => [`/api/people/p_${p}`, `/api/people/p_${p}?for=c_xmas`])];
export type Snap = Record<string, string>;

/**
 * Every reading answer a viewer gets (a guest: their page), bodies and headers but `date`; after the morning batch for
 * this moment has run (ADR 0010), with the pushes they were sent so far.
 */
export async function reads(h: Home, who: Who | Guest): Promise<Snap> {
  h.built.morning(new Date());
  await h.built.pusher.idle();
  const out: Snap = { pushes: String(h.pushes.get(`p_${who}`) ?? 0) };
  for (const u of who.startsWith('g') ? ['/api/guest'] : READS) {
    const r = await as(h, who).get(u);
    expect(r.statusCode, `${who} ${u}: ${r.body}`).toBe(200);
    out[u] = r.body;
    out[`${u} headers`] = JSON.stringify(Object.entries(r.headers).filter(([k]) => k !== 'date' && k !== 'set-cookie').sort());
  }
  return out;
}

export const ok = async <R extends { statusCode: number; body: string }>(p: Promise<R>): Promise<R> => {
  const r = await p;
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r;
};

/** The clock pinned for a file: both twins act at the same moment; `later(h)` moves it on. */
export function pin(at: Date) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); }
export const setNow = (at: Date) => vi.setSystemTime(at);
