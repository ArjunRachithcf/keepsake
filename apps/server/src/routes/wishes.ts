// Wishes (ADR 0007): the home screen, adding (your own, a kid's, or a suggestion), changing, approving, ordering.
// Who may do what is wishes/wishes.ts's; what comes back is the view layer's.
import { MAX_WISHES, type Data } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { id, ids, object, WISH_FIELDS as FIELDS, wishFields as fields } from '../validate';

export function wishRoutes(api: Router, data: Data) {
  api.get('/home', (r) => data.view(r).home(data.listFor(r.query)));

  api.post('/wishes', (r, res) => {
    const b = object(r.body, ['personId', ...FIELDS]);
    const personId = id(b, 'personId', { required: true })!;
    const f = fields(b, true);
    const wishId = data.wishes.add(r, personId, {
      name: f.name!, link: f.link ?? null, priceMinor: f.priceMinor ?? null, quantity: f.quantity ?? 1, note: f.note ?? null,
      mostWanted: f.mostWanted ?? false, celebrationId: f.celebrationId ?? null,
    });
    res.created();
    return data.view(r).wish(wishId);
  });

  api.patch('/wishes/:wishId', (r) => {
    data.wishes.edit(r, r.params.wishId, fields(object(r.body, FIELDS), false));
    return data.view(r).wish(r.params.wishId);
  });

  api.delete('/wishes/:wishId', (r) => data.wishes.remove(r, r.params.wishId));

  api.post('/wishes/:wishId/approve', (r) => {
    data.wishes.approve(r, r.params.wishId);
    return data.view(r).wish(r.params.wishId);
  });

  api.post('/wishes/:wishId/decline', (r) => data.wishes.decline(r, r.params.wishId));

  api.put('/people/:personId/wish-order', (r) => {
    const list = ids(object(r.body, ['wishIds']), 'wishIds', { max: MAX_WISHES });
    if (!list) throw Refused.field('wishIds', 'required');
    data.wishes.order(r, r.params.personId, list);
  });
}
