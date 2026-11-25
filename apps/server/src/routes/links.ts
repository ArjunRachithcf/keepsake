// Guest links (ADR 0009) as the household sees them: make a share link or a personal draw link (the address is shown
// once), list the ones you manage (never their address again), revoke, or give one a new address. Who may is guests/guests.ts's and draws/draws.ts's.
import type { Data } from '../data';
import type { Router } from '../router';
import { object, plainText } from '../validate';

export function linkRoutes(api: Router, data: Data) {
  api.get('/links', (r) => data.view(r).links());

  api.post('/people/:personId/links', (r, res) => {
    const made = data.links.share(r, r.params.personId, plainText(object(r.body, ['label']), 'label', 60, { required: true })!);
    res.created();
    return made;
  });

  api.post('/celebrations/:celebrationId/guests', (r, res) => {
    const made = data.links.invite(r, r.params.celebrationId, plainText(object(r.body, ['name']), 'name', 60, { required: true })!);
    res.created();
    return made;
  });

  api.delete('/links/:linkId', (r) => data.links.revoke(r, r.params.linkId));

  // A new address for the same link (review M-b): its managers only; the old one and its sessions end.
  api.post('/links/:linkId/address', (r) => data.links.reissue(r, r.params.linkId));
}
