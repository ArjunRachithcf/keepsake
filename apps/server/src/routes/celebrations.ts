// Celebrations (spec §3, ADR 0007): everyone sees them; grown-ups host; the host or an admin changes them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { POSTERS } from '@keepsake/contracts';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { addCelebration, editCelebration, mustGetCelebration, removeCelebration, type CelebrationInput } from '../celebrations/celebrations';
import { isDate } from '../celebrations/dates';
import { Refused } from '../errors';
import { ids, nullableText, object, oneOf, text, type Body } from '../validate';
import { viewFor } from '../view/view';

type C = { Params: { celebrationId: string } };
const FIELDS = ['name', 'date', 'place', 'poster', 'recurrence', 'people'];
const RECURRENCES = ['none', 'yearly'] as const;

function fields(b: Body, required: boolean): Partial<CelebrationInput> {
  if (b.date !== undefined && !isDate(b.date)) throw new Refused(400, 'date: a day, YYYY-MM-DD');
  if (required && b.date === undefined) throw new Refused(400, 'date: required');
  const people = ids(b, 'people', { min: 1, max: 100 });
  if (required && !people) throw new Refused(400, 'people: required');
  const out: Partial<CelebrationInput> = {
    name: text(b, 'name', 60, { required }),
    date: b.date as string | undefined,
    place: nullableText(b, 'place', 80),
    poster: oneOf(b, 'poster', POSTERS, { required }),
    recurrence: oneOf(b, 'recurrence', RECURRENCES, { required }),
    people,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export async function celebrationRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const me = (req: FastifyRequest) => req.caller!.person;
  const view = (req: FastifyRequest) => viewFor(db, cfg, me(req));

  app.get('/celebrations', async (req) => view(req).celebrations());

  app.post('/celebrations', async (req, reply) => {
    const f = fields(object(req.body, FIELDS), true) as CelebrationInput;
    const c = addCelebration(db, me(req), { ...f, place: f.place ?? null });
    return reply.code(201).send(view(req).celebration(c));
  });

  app.get<C>('/celebrations/:celebrationId', async (req) => view(req).celebrationPage(mustGetCelebration(db, req.params.celebrationId)));

  app.patch<C>('/celebrations/:celebrationId', async (req) =>
    view(req).celebration(editCelebration(db, me(req), req.params.celebrationId, fields(object(req.body, FIELDS), false))));

  app.delete<C>('/celebrations/:celebrationId', async (req, reply) => {
    removeCelebration(db, me(req), req.params.celebrationId);
    return reply.code(204).send();
  });
}
