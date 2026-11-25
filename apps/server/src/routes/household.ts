// The household (spec §2): everyone in it sees it and each person's page; admins change it. Under HomersLab people
// are HomersLab's, so adding, changing and removing them answers 409 (kids' managers stay Keepsake's).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ROLES } from '@keepsake/contracts';
import type { Config } from '../config';
import { isFresh, type Data } from '../data';
import { Refused } from '../errors';
import { ids, object, oneOf, sizes, strings, text } from '../validate';

type P = { Params: { personId: string } };

export async function householdRoutes(app: FastifyInstance, cfg: Config, data: Data) {
  const me = (req: FastifyRequest) => req.caller!.person;
  const view = (req: FastifyRequest) => data.view(me(req));
  const admin = (req: FastifyRequest) => {
    if (me(req).role !== 'admin') throw new Refused(403, 'admins only');
  };
  const standalone = () => {
    if (cfg.mode !== 'standalone') throw new Refused(409, 'people are managed in HomersLab');
  };

  app.get('/household', async (req) => view(req).household());

  app.patch('/household', async (req) => {
    admin(req);
    const b = object(req.body, ['currency']);
    if (!('currency' in b)) throw new Refused(400, 'currency: required');
    if (b.currency !== null && (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency))) throw new Refused(400, 'currency: three capital letters (ISO 4217), or null');
    data.people.setCurrency(b.currency as string | null);
    return view(req).household();
  });

  app.post('/people', async (req, reply) => {
    admin(req);
    standalone();
    const b = object(req.body, ['name', 'role']);
    const p = data.people.add({ name: text(b, 'name', 60, { required: true })!, role: oneOf(b, 'role', ROLES, { required: true })! });
    return reply.code(201).send(view(req).person(p));
  });

  app.get<P>('/people/:personId', async (req) => view(req).personPage(data.people.get(req.params.personId), data.listFor(req.query)));

  app.patch<P>('/people/:personId', async (req) => {
    admin(req);
    standalone();
    const b = object(req.body, ['name', 'role']);
    return view(req).person(data.people.edit(req.params.personId, { name: text(b, 'name', 60), role: oneOf(b, 'role', ROLES) }));
  });

  app.delete<P>('/people/:personId', async (req, reply) => {
    admin(req);
    standalone();
    data.people.remove(req.params.personId, me(req).id);
    return reply.code(204).send();
  });

  app.put<P>('/people/:personId/managers', async (req) => {
    admin(req);
    const list = ids(object(req.body, ['managerIds']), 'managerIds', { max: 20 });
    if (!list) throw new Refused(400, 'managerIds: required');
    data.people.setManagers(req.params.personId, list);
    return view(req).person(data.people.get(req.params.personId));
  });

  app.post<P>('/people/:personId/invites', async (req, reply) => {
    admin(req);
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
    const p = data.people.get(req.params.personId);
    // Once someone has a passkey, only they add more (an admin cannot slip a passkey into someone's account).
    if (data.people.hasPasskey(p.id)) throw new Refused(409, 'they already sign in; they add passkeys themselves');
    const s = req.caller!.session;
    if (!s || !isFresh(s)) throw new Refused(403, 'sign in again to do this');
    const { url, expiresAt } = data.auth.createInvite({ kind: 'admin', personId: p.id, createdBy: me(req).id });
    return reply.code(201).send(view(req).link(url, expiresAt));
  });

  app.put<P>('/people/:personId/profile', async (req) => {
    const b = object(req.body, ['sizes', 'likes', 'pleaseNo']);
    const row = data.people.setProfile(me(req), req.params.personId, {
      sizes: sizes(b),
      likes: strings(b, 'likes', { maxItems: 50, maxLength: 80 }),
      pleaseNo: strings(b, 'pleaseNo', { maxItems: 50, maxLength: 80 }),
    });
    return view(req).profile(row);
  });
}
