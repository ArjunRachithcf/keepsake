// Wishes (ADR 0007): the home screen, adding (your own, a kid's, or a suggestion), changing, approving, ordering.
// Who may do what is wishes/wishes.ts's; what comes back is the view layer's.
import { MAX_WISHES, type Data, type WishInput } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { bool, id, ids, int, link, nullableId, nullableInt, nullableText, object, text, type Body } from '../validate';

const FIELDS = ['name', 'link', 'priceMinor', 'quantity', 'note', 'mostWanted', 'celebrationId'] as const;

function fields(b: Body, required: boolean): Partial<WishInput> {
  const out: Partial<WishInput> = {
    name: text(b, 'name', 120, { required }),
    link: link(b, 'link'),
    priceMinor: nullableInt(b, 'priceMinor', 0, 100_000_000),
    quantity: int(b, 'quantity', 1, 99),
    note: nullableText(b, 'note', 500),
    mostWanted: bool(b, 'mostWanted'),
    celebrationId: nullableId(b, 'celebrationId', { required }),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

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
