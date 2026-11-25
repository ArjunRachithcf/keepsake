// A guest's routes (ADR 0009): the token from the link's #fragment is exchanged (a POST, rate limited like a sign-in,
// only after the guest taps Open) for a guest session on this device, which lasts as long as the link; after that a
// guest sees what their link reaches (each request names it: X-Keepsake-Link), gives their name, claims, opens their
// draw and asks. Nothing else: these routes take the guest session only, and no other route takes it.
import { CLAIM_STATES } from '@keepsake/contracts';
import type { Data } from '../data';
import { Refused, type Field } from '../errors';
import type { Router } from '../router';
import { int, object, oneOf, plainText, text } from '../validate';

const required = <T>(v: T | undefined, field: Field): T => {
  if (v === undefined) throw Refused.field(field, 'required');
  return v;
};

export function guestRoutes(api: Router, data: Data) {
  api.post('/guest/session', { public: true, signIn: true }, (r, res) => {
    const s = data.guest.start(r, object(r.body, ['token']).token);
    res.startGuest(s.cookie, s.maxAge);
    return s.page;
  });

  api.get('/guest', { guest: true }, (r) => data.guest.view(r).page());

  api.put('/guest/name', { guest: true }, (r) => {
    data.guest.setName(r, plainText(object(r.body, ['name']), 'name', 60, { required: true })!);
    return data.guest.view(r).page();
  });

  api.post('/guest/draw/open', { guest: true }, (r) => {
    data.guest.openDraw(r);
    return data.guest.view(r).page();
  });

  api.put('/guest/wishes/:wishId/claim', { guest: true }, (r) => {
    const quantity = required(int(object(r.body, ['quantity']), 'quantity', 1, 99), 'quantity');
    return data.guest.view(r).wish(data.guest.claim(r, r.params.wishId, quantity));
  });

  api.patch('/guest/wishes/:wishId/claim', { guest: true }, (r) => {
    const state = required(oneOf(object(r.body, ['state']), 'state', CLAIM_STATES), 'state');
    return data.guest.view(r).wish(data.guest.setState(r, r.params.wishId, state));
  });

  api.delete('/guest/wishes/:wishId/claim', { guest: true }, (r) => data.guest.unclaim(r, r.params.wishId));

  api.post('/guest/questions', { guest: true }, (r, res) => {
    const id = data.guest.ask(r, text(object(r.body, ['text']), 'text', 200, { required: true })!);
    res.created();
    return data.guest.view(r).question(id);
  });

  api.post('/guest/sign-out', { guest: true }, (r, res) => {
    data.guest.signOut(r);
    res.endGuest();
  });
}
