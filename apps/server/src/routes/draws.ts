// A celebration's draw (spec §3, ADR 0004): everyone in the household sees who is in it and how many have opened
// theirs; its host sets it up, draws, re-draws and removes it (draws/draws.ts holds the rules); a giver opens their
// own. Hiding it again is the browser's. What comes back is the view layer's, for the request's person: a receiver only
// to their giver, every pair only after the reveal date.
import type { Data, DrawInput } from '../data';
import { MAX_EXCLUSIONS } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { bool, idPairs, ids, nullableDateTime, nullableDay, nullableInt, object, type Body } from '../validate';

const FIELDS = ['people', 'exclusions', 'kidsDraw', 'notLastYear', 'budgetMinor', 'drawTogetherAt', 'revealOn'];
const MONEY = 100_000_000;

function fields(b: Body): Partial<DrawInput> {
  const out: Partial<DrawInput> = {
    people: ids(b, 'people', { max: 100 }),
    exclusions: idPairs(b, 'exclusions', MAX_EXCLUSIONS),
    kidsDraw: bool(b, 'kidsDraw'),
    notLastYear: bool(b, 'notLastYear'),
    budgetMinor: nullableInt(b, 'budgetMinor', 1, MONEY),
    drawTogetherAt: nullableDateTime(b, 'drawTogetherAt'),
    revealOn: nullableDay(b, 'revealOn'),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function drawRoutes(api: Router, data: Data) {
  api.get('/celebrations/:celebrationId/draw', (r) => data.view(r).draw(r.params.celebrationId));

  api.post('/celebrations/:celebrationId/draw', (r, res) => {
    const f = fields(object(r.body, FIELDS));
    if (!f.people) throw Refused.field('people', 'required');
    const id = data.draws.create(r, r.params.celebrationId, {
      people: f.people, exclusions: f.exclusions ?? [], kidsDraw: f.kidsDraw ?? false, notLastYear: f.notLastYear ?? false,
      budgetMinor: f.budgetMinor ?? null, drawTogetherAt: f.drawTogetherAt ?? null, revealOn: f.revealOn ?? null,
    });
    res.created();
    return data.view(r).draw(id);
  });

  api.patch('/celebrations/:celebrationId/draw', (r) => data.view(r).draw(data.draws.edit(r, r.params.celebrationId, fields(object(r.body, FIELDS)))));

  api.delete('/celebrations/:celebrationId/draw', (r) => data.draws.remove(r, r.params.celebrationId));

  api.post('/celebrations/:celebrationId/draw/run', (r) => data.view(r).draw(data.draws.run(r, r.params.celebrationId)));

  api.post('/celebrations/:celebrationId/draw/open', (r) => data.view(r).draw(data.draws.open(r, r.params.celebrationId)));
}
