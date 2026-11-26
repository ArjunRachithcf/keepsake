// The household (spec §2): everyone in it sees it and each person's page; admins change it. Under HomersLab people
// are HomersLab's, so adding, changing and removing them answers 409 (kids' managers stay Keepsake's).
import { ROLES } from '@keepsake/contracts';
import type { Config } from '../config';
import type { Data } from '../data';
import { Refused } from '../errors';
import type { Req, Router } from '../router';
import { bool, ids, object, oneOf, plainText, sizes, strings } from '../validate';

export function householdRoutes(api: Router, cfg: Config, data: Data) {
  const admin = (r: Req) => {
    if (data.me(r).role !== 'admin') throw new Refused(403, 'admins only');
  };
  const standalone = () => {
    if (cfg.mode !== 'standalone') throw new Refused(409, 'people are managed in HomersLab');
  };

  api.get('/household', (r) => data.view(r).household());

  api.patch('/household', (r) => {
    admin(r);
    const b = object(r.body, ['currency']);
    if (!('currency' in b)) throw Refused.field('currency', 'required');
    if (b.currency !== null && (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency))) throw new Refused(400, 'currency: three capital letters (ISO 4217), or null');
    data.people.setCurrency(r, b.currency as string | null);
    return data.view(r).household();
  });

  api.post('/people', (r, res) => {
    admin(r);
    standalone();
    const b = object(r.body, ['name', 'role', 'confirmName']);
    const id = data.people.add(r, { name: plainText(b, 'name', 60, { required: true })!, role: oneOf(b, 'role', ROLES, { required: true })! }, bool(b, 'confirmName') ?? false);
    res.created();
    return data.view(r).person(id);
  });

  api.get('/people/:personId', (r) => data.view(r).personPage(r.params.personId, data.listFor(r.query)));

  api.patch('/people/:personId', (r) => {
    admin(r);
    standalone();
    const b = object(r.body, ['name', 'role', 'confirmName']);
    data.people.edit(r, r.params.personId, { name: plainText(b, 'name', 60), role: oneOf(b, 'role', ROLES) }, bool(b, 'confirmName') ?? false);
    return data.view(r).person(r.params.personId);
  });

  api.delete('/people/:personId', (r) => {
    admin(r);
    standalone();
    data.people.remove(r, r.params.personId);
  });

  api.put('/people/:personId/managers', (r) => {
    admin(r);
    const list = ids(object(r.body, ['managerIds']), 'managerIds', { max: 20 });
    if (!list) throw Refused.field('managerIds', 'required');
    data.people.setManagers(r, r.params.personId, list);
    return data.view(r).person(r.params.personId);
  });

  api.post('/people/:personId/invites', (r, res) => {
    admin(r);
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
    // Once someone has a passkey, only they add more (an admin cannot slip a passkey into someone's account).
    if (data.people.hasPasskey(r.params.personId)) throw new Refused(409, 'they already sign in; they add passkeys themselves');
    data.fresh(r);
    res.created();
    return data.auth.invite(r, 'admin', r.params.personId);
  });

  api.put('/people/:personId/profile', (r) => {
    const b = object(r.body, ['sizes', 'likes', 'pleaseNo']);
    data.people.setProfile(r, r.params.personId, {
      sizes: sizes(b),
      likes: strings(b, 'likes', { maxItems: 50, maxLength: 80, plain: true }),
      pleaseNo: strings(b, 'pleaseNo', { maxItems: 50, maxLength: 80, plain: true }),
    });
    return data.view(r).profile(r.params.personId);
  });
}
