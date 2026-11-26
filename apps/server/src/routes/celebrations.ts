// Celebrations (spec §3, ADR 0007): everyone sees them; grown-ups host; the host or an admin changes them.
import { POSTERS } from '@keepsake/contracts';
import type { CelebrationInput, Data } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { ids, isDate, nullablePlainText, object, oneOf, plainText, type Body } from '../validate';

const FIELDS = ['name', 'date', 'place', 'poster', 'recurrence', 'people'];
const RECURRENCES = ['none', 'yearly'] as const;

function fields(b: Body, required: boolean): Partial<CelebrationInput> {
  if (b.date !== undefined && !isDate(b.date)) throw new Refused(400, 'date: a day, YYYY-MM-DD');
  if (required && b.date === undefined) throw Refused.field('date', 'required');
  const people = ids(b, 'people', { min: 1, max: 100 });
  if (required && !people) throw Refused.field('people', 'required');
  const out: Partial<CelebrationInput> = {
    name: plainText(b, 'name', 60, { required }),
    date: b.date as string | undefined,
    place: nullablePlainText(b, 'place', 80),
    poster: oneOf(b, 'poster', POSTERS, { required }),
    recurrence: oneOf(b, 'recurrence', RECURRENCES, { required }),
    people,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function celebrationRoutes(api: Router, data: Data) {
  api.get('/celebrations', (r) => data.view(r).celebrations());

  api.post('/celebrations', (r, res) => {
    const f = fields(object(r.body, FIELDS), true) as CelebrationInput;
    const id = data.celebrations.add(r, { ...f, place: f.place ?? null });
    res.created();
    return data.view(r).celebration(id);
  });

  api.get('/celebrations/:celebrationId', (r) => data.view(r).celebrationPage(r.params.celebrationId));

  api.patch('/celebrations/:celebrationId', (r) => {
    data.celebrations.edit(r, r.params.celebrationId, fields(object(r.body, FIELDS), false));
    return data.view(r).celebration(r.params.celebrationId);
  });

  api.delete('/celebrations/:celebrationId', (r) => data.celebrations.remove(r, r.params.celebrationId));
}
