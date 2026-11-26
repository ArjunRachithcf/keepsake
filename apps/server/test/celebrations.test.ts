// Celebrations (ADR 0007): dates that come back yearly, who hosts and changes them, and what happens to wishes when
// someone leaves one or it is removed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { daysBetween, isDate, nextDate, today } from '../src/celebrations/dates';
import type { Db } from '../src/db/open';
import { ORIGIN, household, sessionCookie, standalone } from './helpers';

describe('dates', () => {
  it('a one-off keeps its date; a yearly one comes back, never before its first date', () => {
    expect(nextDate('2020-01-01', 'none', '2026-11-25')).toBe('2020-01-01');
    expect(nextDate('2026-12-24', 'yearly', '2026-11-25')).toBe('2026-12-24');
    expect(nextDate('2019-03-14', 'yearly', '2026-11-25')).toBe('2027-03-14');
    expect(nextDate('2019-11-25', 'yearly', '2026-11-25')).toBe('2026-11-25'); // today counts
    expect(nextDate('2028-05-01', 'yearly', '2026-11-25')).toBe('2028-05-01');
  });
  it('29 February falls on 28 February in other years', () => {
    expect(nextDate('2020-02-29', 'yearly', '2026-11-25')).toBe('2027-02-28');
    expect(nextDate('2020-02-29', 'yearly', '2027-03-01')).toBe('2028-02-29');
  });
  it('days, and today in the household\'s time zone', () => {
    expect(daysBetween('2026-11-25', '2026-12-24')).toBe(29);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // across a DST change
    const t = new Date('2026-11-25T23:30:00Z');
    expect(today('UTC', t)).toBe('2026-11-25');
    expect(today('Asia/Tokyo', t)).toBe('2026-11-26');
    expect(today('America/New_York', t)).toBe('2026-11-25');
  });
  it('only real days', () => {
    for (const d of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', 'tomorrow', '1800-01-01']) expect(isDate(d), d).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
  });
});

describe('the routes', () => {
  let built: BuiltApp;
  let db: Db;
  beforeEach(async () => { db = household(); built = await buildApp(standalone(), db); });
  afterEach(() => built.app.close());
  const send = (who: string, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    built.app.inject({ method, url, payload, headers: { cookie: sessionCookie(db, who), origin: ORIGIN } });
  const get = (who: string, url: string) => built.app.inject({ url, headers: { cookie: sessionCookie(db, who) } });
  const NEW = { name: 'Cousins\' exchange', date: '2027-01-06', place: 'At Robin\'s', poster: 'night', recurrence: 'yearly', people: ['p_robin', 'p_sam'] };

  it('grown-ups host; kids do not', async () => {
    expect((await send('p_mia', 'POST', '/api/celebrations', NEW)).statusCode).toBe(403);
    const r = await send('p_robin', 'POST', '/api/celebrations', NEW);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Cousins\' exchange', host: { id: 'p_robin', name: 'Robin' }, people: ['p_robin', 'p_sam'], canEdit: true, upcoming: true });
  });

  it('checks its fields', async () => {
    for (const body of [{ ...NEW, date: '2027-02-30' }, { ...NEW, poster: 'neon' }, { ...NEW, people: [] }, { ...NEW, people: ['p_nobody'] },
      { ...NEW, recurrence: 'monthly' }, { ...NEW, draw: true }, { ...NEW, name: '' }]) {
      expect((await send('p_robin', 'POST', '/api/celebrations', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('its host and the admins change and remove it, nobody else', async () => {
    expect((await send('p_robin', 'PATCH', '/api/celebrations/c_xmas', { place: 'x' })).statusCode).toBe(403);
    expect((await send('p_mia', 'DELETE', '/api/celebrations/c_mia')).statusCode).toBe(403);
    expect((await send('p_sam', 'PATCH', '/api/celebrations/c_mia', { poster: 'gold' })).json().poster).toBe('gold');
    expect((await send('p_alex', 'PATCH', '/api/celebrations/c_mia', { place: 'The park' })).json().place).toBe('The park');
    expect((await get('p_robin', '/api/celebrations/c_xmas')).json().celebration.canEdit).toBe(false);
  });

  it('someone taken out keeps their wishes for it, now for any time', async () => {
    const r = await send('p_alex', 'PATCH', '/api/celebrations/c_xmas', { people: ['p_alex', 'p_robin'] });
    expect(r.json().people.sort()).toEqual(['p_alex', 'p_robin']);
    const sam = (await get('p_sam', '/api/people/p_sam')).json().wishes;
    expect(sam).toMatchObject([{ name: 'A cookbook', celebrationId: null }, { name: 'A cast-iron pan', celebrationId: null }]);
    expect((await get('p_alex', '/api/people/p_alex')).json().wishes.find((w: { id: string }) => w.id === 'w_alex_tent').celebrationId).toBe('c_xmas');
  });

  it('removing it keeps its wishes, for any time', async () => {
    expect((await send('p_alex', 'DELETE', '/api/celebrations/c_xmas')).statusCode).toBe(204);
    expect((await get('p_alex', '/api/celebrations/c_xmas')).statusCode).toBe(404);
    expect((await get('p_sam', '/api/people/p_alex')).json().wishes.find((w: { id: string }) => w.id === 'w_alex_tent')).toMatchObject({ celebrationId: null });
  });

  it('coming up by next date; one-off ones in the past apart', async () => {
    const list = (await get('p_robin', '/api/celebrations')).json();
    const next = list.upcoming.map((c: { nextDate: string }) => c.nextDate);
    expect(next).toEqual([...next].sort());
    expect(list.upcoming.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['c_xmas', 'c_mia']));
    expect(list.past.map((c: { id: string }) => c.id)).toEqual(['c_old']);
    expect(list.past[0].daysUntil).toBeLessThan(0);
  });
});

describe('a cap on celebrations (Gate routes, Info)', () => {
  let built: BuiltApp | undefined;
  afterEach(async () => { await built?.app.close(); built = undefined; });
  it(`one grown-up hosts at most ${100} celebrations; others still can`, async () => {
    const db = household();
    built = await buildApp(standalone(), db);
    const add = (who: string, i: number) => built!.app.inject({ method: 'POST', url: '/api/celebrations', headers: { cookie: sessionCookie(db, who), origin: ORIGIN },
      payload: { name: `Party ${i}`, date: '2027-01-01', recurrence: 'none', poster: 'pine', people: ['p_alex', 'p_robin'] } });
    const hosted = db.$client.prepare('SELECT count(*) AS n FROM celebration WHERE host_id = ?').get('p_robin') as { n: number };
    for (let i = hosted.n; i < 100; i++) expect((await add('p_robin', i)).statusCode).toBe(201);
    const r = await add('p_robin', 100);
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'at most 100 celebrations for one host' }]);
    expect((await add('p_alex', 0)).statusCode).toBe(201);
  });
});
