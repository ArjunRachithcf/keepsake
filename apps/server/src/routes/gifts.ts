// Gifts (spec §3, ADR 0003): claim, bought, given, unclaim; group gifts and shares; after the celebration, a giver's
// name on a gift. Who may act is gifts/gifts.ts's (givers only: never the wish's person, never a kid, decided before
// any gift is read); what comes back is the view layer's, for the request's person.
import { CLAIM_STATES, GROUP_STATES } from '@keepsake/contracts';
import type { Data } from '../data';
import { Refused, type Field } from '../errors';
import type { Router } from '../router';
import { bool, int, object, oneOf } from '../validate';

const MONEY = 100_000_000;
const required = <T>(v: T | undefined, field: Field): T => {
  if (v === undefined) throw Refused.field(field, 'required');
  return v;
};

export function giftRoutes(api: Router, data: Data) {
  api.put('/wishes/:wishId/claim', (r) => {
    const quantity = required(int(object(r.body, ['quantity']), 'quantity', 1, 99), 'quantity');
    return data.view(r).wish(data.gifts.claim(r, r.params.wishId, quantity));
  });

  api.patch('/wishes/:wishId/claim', (r) => {
    const state = required(oneOf(object(r.body, ['state']), 'state', CLAIM_STATES), 'state');
    return data.view(r).wish(data.gifts.setState(r, r.params.wishId, state));
  });

  api.delete('/wishes/:wishId/claim', (r) => data.gifts.unclaim(r, r.params.wishId));

  api.delete('/wishes/:wishId/imported-claim', (r) => data.gifts.releaseImported(r, r.params.wishId));

  api.put('/wishes/:wishId/named', (r) => {
    const named = required(bool(object(r.body, ['named']), 'named'), 'named');
    return data.view(r).wish(data.gifts.setNamed(r, r.params.wishId, named));
  });

  api.post('/wishes/:wishId/group', (r) => {
    const target = required(int(object(r.body, ['targetMinor']), 'targetMinor', 1, MONEY), 'targetMinor');
    return data.view(r).wish(data.gifts.startGroup(r, r.params.wishId, target));
  });

  api.patch('/wishes/:wishId/group', (r) => {
    const b = object(r.body, ['targetMinor', 'state']);
    const targetMinor = int(b, 'targetMinor', 1, MONEY);
    const state = oneOf(b, 'state', GROUP_STATES);
    if (targetMinor === undefined && state === undefined) throw new Refused(400, 'targetMinor or state: one of them');
    return data.view(r).wish(data.gifts.editGroup(r, r.params.wishId, { targetMinor, state }));
  });

  api.delete('/wishes/:wishId/group', (r) => data.gifts.endGroup(r, r.params.wishId));

  api.put('/wishes/:wishId/group/share', (r) => {
    const amount = required(int(object(r.body, ['amountMinor']), 'amountMinor', 1, MONEY), 'amountMinor');
    return data.view(r).wish(data.gifts.chipIn(r, r.params.wishId, amount));
  });

  api.delete('/wishes/:wishId/group/share', (r) => data.gifts.withdraw(r, r.params.wishId));
}
