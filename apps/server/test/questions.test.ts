// Anonymous questions (ADR 0008) on the raw responses (bodies and headers): nobody but the asker ever gets who asked,
// not the person, a kid, the host, an admin or a guest. Twin households differ only in who asked the same question at
// the same moment; every other viewer's every reading answer must be byte for byte the same in both, before the
// morning batch, after it, after the answer and after an admin removed it. Before the batch, everyone but the asker
// sees exactly what they would with no question at all (no timing oracle). Then the rules: limits, who may ask,
// answer, decline, add a wish instead, take back and remove.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { today } from '../src/celebrations/dates';
import * as t from '../src/db/schema';
import { startGuestSession } from '../src/guests/guests';
import { deliveryOf } from '../src/questions/questions';
import { GUESTS, PEOPLE, as, makeHome, ok, pin, reads, setNow, tokenOf, type Guest, type Home, type Who } from './m4';

const T0 = new Date('2026-12-01T10:00:00.000Z');
const BATCH = new Date('2026-12-02T08:00:00.000Z');
beforeAll(() => pin(T0));
afterAll(() => { vi.useRealTimers(); });
const homes: Home[] = [];
const home = async () => { const h = await makeHome(); homes.push(h); return h; };
afterEach(async () => { setNow(T0); for (const h of homes.splice(0)) await h.built.app.close(); });

type Asker = Who | Guest;
const askUrl = (asker: Asker, person: string) => (asker.startsWith('g') ? '/api/guest/questions' : `/api/people/${person}/questions`);
async function askIn(h: Home, asker: Asker, person: string, text = 'Leather or wool gloves?') {
  const r = await ok(as(h, asker).send('POST', askUrl(asker, person), { text }));
  return r.json().id as string;
}
/** Guest sessions last 12 hours: after the clock moves, each guest opens their link again. */
const reopen = (h: Home) => { for (const g of Object.keys(GUESTS)) h.cookies[g] = `keepsake_guest=${startGuestSession(h.db, tokenOf(g), today('UTC')).token}`; };
const ALL: (Who | Guest)[] = [...PEOPLE, ...(Object.keys(GUESTS) as Guest[])];

describe.each([
  { person: 'p_robin', askers: ['quinn', 'uma'] as Asker[], answerer: 'robin' as Who, title: 'a grown-up asked by one of two grown-ups' },
  { person: 'p_mia', askers: ['quinn', 'uma'] as Asker[], answerer: 'sam' as Who, title: 'a kid (her parent answers) asked by one of two grown-ups' },
  { person: 'p_robin', askers: ['gR', 'quinn'] as Asker[], answerer: 'robin' as Who, title: 'a grown-up asked by a guest or a grown-up' },
])('who asked is sent to nobody else: $title', ({ person, askers, answerer }) => {
  it('every other viewer\'s answers are the same whoever asked, and before the batch the same as with no question', async () => {
    const [a, b, none] = [await home(), await home(), await home()];
    const qa = await askIn(a, askers[0]!, person);
    const qb = await askIn(b, askers[1]!, person);
    // The same question in both: only the asker differs.
    b.db.update(t.question).set({ id: qa }).where(eq(t.question.id, qb)).run();
    const viewers = ALL.filter((v) => !askers.includes(v));
    const same = async (stage: string, withNone = false) => {
      for (const v of viewers) {
        const [x, y] = [await reads(a, v), await reads(b, v)];
        expect(x, `${stage}: ${v}`).toEqual(y);
        if (withNone) expect(x, `${stage}, as with no question: ${v}`).toEqual(await reads(none, v));
      }
    };
    await same('before the batch', true);
    // The asker sees theirs at once, marked theirs, with when it arrives.
    const mine = askers[0]!.startsWith('g') ? (await as(a, askers[0]!).get('/api/guest')).json().questions
      : (await as(a, askers[0]!).get(`/api/people/${person}`)).json().questions;
    expect(mine).toEqual([expect.objectContaining({ id: qa, state: 'waiting', mine: true, arrivesAt: BATCH.toISOString(), on: '2026-12-02' })]);

    setNow(new Date(BATCH.getTime() - 1));
    for (const h of [a, b, none]) reopen(h);
    await same('a moment before 08:00', true);

    setNow(BATCH);
    for (const h of [a, b, none]) reopen(h);
    await same('from 08:00');
    const waiting = (await as(a, answerer).get('/api/home')).json().questions;
    expect(waiting).toEqual([{ id: qa, text: 'Leather or wool gloves?', on: '2026-12-02', for: { id: person, name: person === 'p_mia' ? 'Mia' : 'Robin' } }]);

    for (const h of [a, b]) await ok(as(h, answerer).send('POST', `/api/questions/${qa}/answer`, { text: 'Wool, please' }));
    await same('answered');
    const seen = (await as(a, 'alex').get(`/api/people/${person}`)).json().questions;
    expect(seen).toEqual([{ id: qa, text: 'Leather or wool gloves?', on: '2026-12-02', state: 'answered', answer: 'Wool, please', wish: null, mine: false, arrivesAt: null }]);

    for (const h of [a, b]) expect((await as(h, 'alex').send('DELETE', `/api/questions/${qa}`)).statusCode).toBe(204);
    await same('removed by an admin');
    // The removal is kept as who removed which question, never who asked.
    const audit = a.db.select().from(t.audit).where(eq(t.audit.action, 'question_removed')).all();
    expect(audit.map((x) => [x.actorId, x.subjectId])).toEqual([['p_alex', qa]]);
  }, 60_000);
});

describe('the rules', () => {
  it('the morning batch: never before 08:00 the next day, household time', () => {
    expect(deliveryOf(new Date('2026-12-01T07:59:00Z'), 'UTC').toISOString()).toBe('2026-12-02T08:00:00.000Z');
    expect(deliveryOf(new Date('2026-12-01T23:30:00Z'), 'Europe/Zurich').toISOString()).toBe('2026-12-03T07:00:00.000Z');
    expect(deliveryOf(new Date('2026-07-01T10:00:00Z'), 'Europe/Zurich').toISOString()).toBe('2026-07-02T06:00:00.000Z');
    expect(deliveryOf(new Date('2026-03-28T10:00:00Z'), 'Europe/Zurich').toISOString()).toBe('2026-03-29T06:00:00.000Z');
  });

  it('who may ask: grown-ups and guests; not the person, not a kid, not a kid\'s own parent', async () => {
    const h = await home();
    expect((await as(h, 'robin').send('POST', '/api/people/p_robin/questions', { text: 'x?' })).statusCode).toBe(403);
    expect((await as(h, 'mia').send('POST', '/api/people/p_robin/questions', { text: 'x?' })).statusCode).toBe(403);
    expect((await as(h, 'sam').send('POST', '/api/people/p_mia/questions', { text: 'x?' })).statusCode).toBe(403);
    expect((await as(h, 'robin').send('POST', '/api/people/p_mia/questions', { text: 'x?' })).statusCode).toBe(201);
    expect((await as(h, 'robin').send('POST', '/api/people/nobody/questions', { text: 'x?' })).statusCode).toBe(404);
    expect((await as(h, 'robin').send('POST', '/api/people/p_sam/questions', { text: '' })).statusCode).toBe(400);
    expect((await as(h, 'robin').send('POST', '/api/people/p_sam/questions', { text: 'x'.repeat(201) })).statusCode).toBe(400);
  });

  it('limits: three open per asker and person, thirty delivered open per person (those on their way do not count); an answer makes room', async () => {
    const h = await home();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await askIn(h, 'quinn', 'p_robin', `Question ${i}?`));
    const r = await as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'One more?' });
    expect([r.statusCode, r.json().error]).toEqual([409, 'you have 3 questions waiting for them: wait for an answer']);
    expect((await as(h, 'uma').send('POST', '/api/people/p_robin/questions', { text: 'Mine?' })).statusCode).toBe(201);
    setNow(BATCH);
    await ok(as(h, 'robin').send('POST', `/api/questions/${ids[0]}/decline`));
    expect((await as(h, 'quinn').send('POST', '/api/people/p_robin/questions', { text: 'One more?' })).statusCode).toBe(201);
    // 29 delivered and open now (and Quinn's new one on its way, which does not count: nobody can see it yet).
    for (let i = 0; i < 26; i++) h.db.insert(t.question).values({ id: `q_fill${i}`, personId: 'p_robin', askerId: null, text: 'x', askedAt: T0.toISOString(), deliverAt: T0.toISOString(), state: 'open' }).run();
    expect((await as(h, 'alex').send('POST', '/api/people/p_robin/questions', { text: 'Still room?' })).statusCode).toBe(201);
    h.db.insert(t.question).values({ id: 'q_fill_last', personId: 'p_robin', askerId: null, text: 'x', askedAt: T0.toISOString(), deliverAt: T0.toISOString(), state: 'open' }).run();
    const full = await as(h, 'sam').send('POST', '/api/people/p_robin/questions', { text: 'Full?' });
    expect([full.statusCode, full.json().error]).toEqual([409, 'they have many questions waiting: try again later']);
  });

  it('only the person (a kid\'s parent for a kid) answers, once, after the batch; a kid sees no questions', async () => {
    const h = await home();
    const q = await askIn(h, 'robin', 'p_mia');
    const k = await askIn(h, 'robin', 'p_sam');
    // before the batch it does not exist for them
    expect((await as(h, 'sam').send('POST', `/api/questions/${q}/answer`, { text: 'Red' })).statusCode).toBe(404);
    setNow(BATCH);
    expect((await as(h, 'mia').send('POST', `/api/questions/${q}/answer`, { text: 'Red' })).statusCode).toBe(404);
    expect((await as(h, 'mia').get('/api/home')).json().questions).toEqual([]);
    expect((await as(h, 'mia').get('/api/people/p_mia')).json()).not.toHaveProperty('questions');
    expect((await as(h, 'leo').get('/api/people/p_sam')).json()).not.toHaveProperty('questions');
    expect((await as(h, 'alex').send('POST', `/api/questions/${q}/answer`, { text: 'Red' })).statusCode).toBe(403);
    expect((await as(h, 'sam').send('POST', `/api/questions/${q}/answer`, { text: 'Red' })).statusCode).toBe(204);
    expect((await as(h, 'sam').send('POST', `/api/questions/${q}/answer`, { text: 'Blue' })).statusCode).toBe(409);
    expect((await as(h, 'sam').get('/api/people/p_sam')).json()).not.toHaveProperty('questions');
    expect((await as(h, 'sam').get('/api/home')).json().questions.map((x: { id: string }) => x.id)).toEqual([k]);
    // Answered for her, it is still nothing to Mia (review L3): a 404, as for a question that does not exist.
    for (const id of [q, 'qzzzzzzzzzzzzzzzzzzzzz']) expect((await as(h, 'mia').send('DELETE', `/api/questions/${id}`)).json().error, id).toBe('no such question');
  });

  it('decline: only its asker sees it was declined', async () => {
    const h = await home();
    const q = await askIn(h, 'quinn', 'p_robin');
    setNow(BATCH);
    await ok(as(h, 'robin').send('POST', `/api/questions/${q}/decline`));
    expect((await as(h, 'quinn').get('/api/people/p_robin')).json().questions).toEqual([expect.objectContaining({ id: q, state: 'declined', mine: true })]);
    for (const v of ['alex', 'uma', 'sam'] as const) expect((await as(h, v).get('/api/people/p_robin')).json().questions, v).toEqual([]);
  });

  it('"Add a wish instead": the wish joins their list and answers the question', async () => {
    const h = await home();
    const q = await askIn(h, 'quinn', 'p_mia');
    setNow(BATCH);
    const w = await as(h, 'sam').send('POST', `/api/questions/${q}/wish`, { name: 'Blue mittens', celebrationId: null });
    expect(w.statusCode, w.body).toBe(201);
    expect(w.json()).toMatchObject({ name: 'Blue mittens', personId: 'p_mia', state: 'listed' });
    expect((await as(h, 'uma').get('/api/people/p_mia')).json().questions).toEqual([expect.objectContaining({ state: 'answered', answer: null, wish: { id: w.json().id, name: 'Blue mittens' } })]);
  });

  it('take back and remove: its asker before the batch; after it only an admin; others 403, the unseen 404', async () => {
    const h = await home();
    const a = await askIn(h, 'quinn', 'p_robin', 'First?');
    const b = await askIn(h, 'quinn', 'p_robin', 'Second?');
    expect((await as(h, 'uma').send('DELETE', `/api/questions/${a}`)).statusCode).toBe(404);
    expect((await as(h, 'quinn').send('DELETE', `/api/questions/${a}`)).statusCode).toBe(204);
    setNow(BATCH);
    const late = await as(h, 'quinn').send('DELETE', `/api/questions/${b}`);
    expect([late.statusCode, late.json().error]).toEqual([409, 'it has reached them: it stays']);
    expect((await as(h, 'uma').send('DELETE', `/api/questions/${b}`)).statusCode).toBe(403);
    expect((await as(h, 'robin').send('DELETE', `/api/questions/${b}`)).statusCode).toBe(403);
    expect((await as(h, 'alex').send('DELETE', `/api/questions/${b}`)).statusCode).toBe(204);
    expect(h.db.select().from(t.question).all()).toEqual([]);
  });

  it('ids carry no time, and nothing about a question\'s asker is in any answer to the person', async () => {
    const h = await home();
    const q = await askIn(h, 'quinn', 'p_robin');
    expect(q).toMatch(/^[A-Za-z0-9_-]{22}$/);
    setNow(BATCH);
    for (const u of ['/api/home', '/api/people/p_robin', '/api/people/p_quinn']) {
      const body = (await as(h, 'robin').get(u)).body;
      expect(body).not.toContain('askedAt');
      expect(body).not.toContain('asker');
    }
  });
});
