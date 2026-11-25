// Ideas (spec §3): a grown-up keeps gift ideas for a person, shared with the other grown-ups. The person and kids
// never get one: every answer they can get is byte for byte the answer in a twin household with no ideas (bodies and
// headers, guests too). While a draw is secret, an idea by one of its people for another names nobody (review H1).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as t from '../src/db/schema';
import { nextDate } from '../src/celebrations/dates';
import { GUESTS, as, makeHome, ok, pin, reads, type Guest, type Home } from './m4';

beforeAll(() => pin(new Date('2026-12-01T10:00:00.000Z')));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async () => { const h = await makeHome(); homes.push(h); return h; };
afterEach(async () => { for (const h of homes.splice(0)) await h.built.app.close(); });

describe('ideas never reach their person, a kid or a guest', () => {
  it.each([['p_robin', 'robin'], ['p_mia', 'mia']] as const)('ideas for %s', async (person, self) => {
    const [a, none] = [await home(), await home()];
    await ok(as(a, 'quinn').send('POST', `/api/people/${person}/ideas`, { text: 'A pasta machine' }));
    await ok(as(a, 'uma').send('POST', `/api/people/${person}/ideas`, { text: 'Climbing lessons' }));
    // The person's refusal is decided from them alone: the same in both households.
    for (const h of [a, none]) expect((await as(h, self).send('POST', `/api/people/${person}/ideas`, { text: 'x' })).statusCode).toBe(403);
    for (const v of [self, 'mia', 'leo', ...(Object.keys(GUESTS) as Guest[])] as const) {
      expect(await reads(a, v), v).toEqual(await reads(none, v));
    }
    const seen = (await as(a, 'alex').get(`/api/people/${person}`)).json().ideas;
    expect(seen.map((i: { text: string; by: { name: string } }) => [i.text, i.by.name]).sort()).toEqual([['A pasta machine', 'Quinn'], ['Climbing lessons', 'Uma']]);
    expect((await as(a, 'quinn').get(`/api/people/${person}`)).json().ideas.find((i: { mine: boolean }) => i.mine).text).toBe('A pasta machine');
  }, 30_000);

  it('removing: its author or an admin; the person gets a 404 as for none', async () => {
    const h = await home();
    const id = (await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/ideas', { text: 'Gloves' }))).json().id;
    expect((await as(h, 'robin').send('DELETE', `/api/ideas/${id}`)).statusCode).toBe(404);
    expect((await as(h, 'mia').send('DELETE', `/api/ideas/${id}`)).statusCode).toBe(404);
    expect((await as(h, 'uma').send('DELETE', `/api/ideas/${id}`)).statusCode).toBe(403);
    expect((await as(h, 'alex').send('DELETE', `/api/ideas/${id}`)).statusCode).toBe(204);
    expect((await as(h, 'mia').send('POST', '/api/people/p_robin/ideas', { text: 'x' })).statusCode).toBe(403);
    for (let i = 0; i < 50; i++) h.db.insert(t.idea).values({ id: `i_${i}`, personId: 'p_sam', authorId: 'p_alex', text: 'x', createdAt: new Date().toISOString() }).run();
    expect((await as(h, 'robin').send('POST', '/api/people/p_sam/ideas', { text: 'One more' })).statusCode).toBe(409);
  });

  it('while a draw is secret, an idea by one of its people for another names nobody but its author', async () => {
    const h = await home();
    const year = Number(nextDate('2024-12-24', 'yearly', '2026-12-01').slice(0, 4));
    h.db.insert(t.draw).values({ id: 'd_x', celebrationId: 'c_xmas', year, rulesVersion: 1, drawnAt: '2026-11-30T10:00:00.000Z', createdBy: 'p_alex', createdAt: '2026-11-30T10:00:00.000Z', updatedAt: '2026-11-30T10:00:00.000Z' }).run();
    for (const p of ['alex', 'sam', 'robin', 'mia']) h.db.insert(t.drawParticipant).values({ id: `dp_${p}`, drawId: 'd_x', kind: 'person', personId: `p_${p}`, createdAt: '2026-11-30T10:00:00.000Z' }).run();
    await ok(as(h, 'sam').send('POST', '/api/people/p_robin/ideas', { text: 'A lamp' }));
    await ok(as(h, 'quinn').send('POST', '/api/people/p_robin/ideas', { text: 'A mug' }));
    const by = async (v: 'alex' | 'sam' | 'uma') => Object.fromEntries((await as(h, v).get('/api/people/p_robin')).json().ideas.map((i: { text: string; by: { name: string } | null }) => [i.text, i.by?.name ?? null]));
    expect(await by('alex')).toEqual({ 'A lamp': null, 'A mug': 'Quinn' });
    expect(await by('uma')).toEqual({ 'A lamp': null, 'A mug': 'Quinn' });
    expect(await by('sam')).toEqual({ 'A lamp': 'Sam', 'A mug': 'Quinn' });
  });
});
