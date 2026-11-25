// The household (spec §2): everyone in it sees it and each person's page; admins change it. Under HomersLab people
// are HomersLab's, so adding, changing and removing them answers 409 (kids' managers stay Keepsake's).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { createInvite } from '../auth/invites';
import { isFresh } from '../auth/sessions';
import { Refused } from '../errors';
import { addPerson, editPerson, hasPasskey, mustGetPerson, removePerson, setCurrency, setManagers } from '../household/people';
import { setProfile } from '../household/profile';
import { ids, listFor, object, oneOf, sizes, strings, text } from '../validate';
import { viewFor } from '../view/view';
import { ROLES } from '@keepsake/contracts';

type P = { Params: { personId: string } };

export async function householdRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const me = (req: FastifyRequest) => req.caller!.person;
  const view = (req: FastifyRequest) => viewFor(db, cfg, me(req));
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
    setCurrency(db, b.currency as string | null);
    return view(req).household();
  });

  app.post('/people', async (req, reply) => {
    admin(req);
    standalone();
    const b = object(req.body, ['name', 'role']);
    const p = addPerson(db, { name: text(b, 'name', 60, { required: true })!, role: oneOf(b, 'role', ROLES, { required: true })! });
    return reply.code(201).send(view(req).person(p));
  });

  app.get<P>('/people/:personId', async (req) => view(req).personPage(mustGetPerson(db, req.params.personId), listFor(db, req.query)));

  app.patch<P>('/people/:personId', async (req) => {
    admin(req);
    standalone();
    const b = object(req.body, ['name', 'role']);
    return view(req).person(editPerson(db, req.params.personId, { name: text(b, 'name', 60), role: oneOf(b, 'role', ROLES) }));
  });

  app.delete<P>('/people/:personId', async (req, reply) => {
    admin(req);
    standalone();
    removePerson(db, req.params.personId, me(req).id);
    return reply.code(204).send();
  });

  app.put<P>('/people/:personId/managers', async (req) => {
    admin(req);
    const b = object(req.body, ['managerIds']);
    const list = ids(b, 'managerIds', { max: 20 });
    if (!list) throw new Refused(400, 'managerIds: required');
    setManagers(db, req.params.personId, list);
    return view(req).person(mustGetPerson(db, req.params.personId));
  });

  app.post<P>('/people/:personId/invites', async (req, reply) => {
    admin(req);
    if (cfg.mode !== 'standalone') throw new Refused(404, 'HomersLab signs people in');
    const p = mustGetPerson(db, req.params.personId);
    // Once someone has a passkey, only they add more (an admin cannot slip a passkey into someone's account).
    if (hasPasskey(db, p.id)) throw new Refused(409, 'they already sign in; they add passkeys themselves');
    const s = req.caller!.session;
    if (!s || !isFresh(s)) throw new Refused(403, 'sign in again to do this');
    const { url, expiresAt } = createInvite(db, cfg, { kind: 'admin', personId: p.id, createdBy: me(req).id });
    return reply.code(201).send(view(req).link(url, expiresAt));
  });

  app.put<P>('/people/:personId/profile', async (req) => {
    const b = object(req.body, ['sizes', 'likes', 'pleaseNo']);
    const row = setProfile(db, me(req), req.params.personId, {
      sizes: sizes(b),
      likes: strings(b, 'likes', { maxItems: 50, maxLength: 80 }),
      pleaseNo: strings(b, 'pleaseNo', { maxItems: 50, maxLength: 80 }),
    });
    return view(req).profile(row);
  });
}
