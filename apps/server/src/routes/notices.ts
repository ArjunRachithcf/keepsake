// Notices, Web Push, "Remind me" and thank-yous (ADR 0010); "Add from a link" (ADR 0011). Who may act is the facade's
// and the domain modules'; what comes back is the view layer's, for the request's person.
import type { Data } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { endpoint, nullableInt, object, pushSubscription, shopLink, text } from '../validate';

export function noticeRoutes(api: Router, data: Data) {
  api.get('/notices', (r) => data.view(r).notices());

  api.post('/notices/read', (r) => data.notices.read(r));

  api.get('/push', (r) => data.view(r).push());

  api.put('/push/subscription', (r) => data.push.subscribe(r, pushSubscription(r.body)));

  api.post('/push/unsubscribe', (r) => data.push.unsubscribe(r, endpoint(r.body)));

  api.put('/people/:personId/reminder', (r) => {
    const b = object(r.body, ['days']);
    if (b.days === undefined) throw Refused.field('days', 'required');
    data.notices.remind(r, r.params.personId, nullableInt(b, 'days', 1, 60) ?? null);
  });

  api.put('/wishes/:wishId/thanks', (r) => {
    const wishId = data.thanks.say(r, r.params.wishId, text(object(r.body, ['text']), 'text', 500, { required: true })!);
    return data.view(r).thanks(wishId);
  });

  api.post('/link-preview', (r) => data.preview(r, shopLink(r.body)));
}
