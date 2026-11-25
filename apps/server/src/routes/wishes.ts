// Wishes (ADR 0007): the home screen, adding (your own, a kid's, or a suggestion), changing, approving, ordering.
// Who may do what is wishes/wishes.ts's; what comes back is the view layer's.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { Refused } from '../errors';
import { approveWish, addWish, declineWish, editWish, orderWishes, removeWish, type WishInput } from '../wishes/wishes';
import { bool, id, ids, int, link, listFor, nullableId, nullableInt, nullableText, object, text, type Body } from '../validate';
import { viewFor } from '../view/view';

type W = { Params: { wishId: string } };
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

export async function wishRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const me = (req: FastifyRequest) => req.caller!.person;
  const view = (req: FastifyRequest) => viewFor(db, cfg, me(req));

  app.get('/home', async (req) => view(req).home(listFor(db, req.query)));

  app.post('/wishes', async (req, reply) => {
    const b = object(req.body, ['personId', ...FIELDS]);
    const personId = id(b, 'personId', { required: true })!;
    const f = fields(b, true);
    const w = addWish(db, me(req), personId, {
      name: f.name!, link: f.link ?? null, priceMinor: f.priceMinor ?? null, quantity: f.quantity ?? 1, note: f.note ?? null,
      mostWanted: f.mostWanted ?? false, celebrationId: f.celebrationId ?? null,
    });
    return reply.code(201).send(view(req).wish(w));
  });

  app.patch<W>('/wishes/:wishId', async (req) => view(req).wish(editWish(db, me(req), req.params.wishId, fields(object(req.body, FIELDS), false))));

  app.delete<W>('/wishes/:wishId', async (req, reply) => {
    removeWish(db, me(req), req.params.wishId);
    return reply.code(204).send();
  });

  app.post<W>('/wishes/:wishId/approve', async (req) => view(req).wish(approveWish(db, me(req), req.params.wishId)));

  app.post<W>('/wishes/:wishId/decline', async (req, reply) => {
    declineWish(db, me(req), req.params.wishId);
    return reply.code(204).send();
  });

  app.put<{ Params: { personId: string } }>('/people/:personId/wish-order', async (req, reply) => {
    const list = ids(object(req.body, ['wishIds']), 'wishIds', { max: 500 });
    if (!list) throw new Refused(400, 'wishIds: required');
    orderWishes(db, me(req), req.params.personId, list);
    return reply.code(204).send();
  });
}
