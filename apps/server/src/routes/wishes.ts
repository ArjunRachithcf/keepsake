// Wishes (ADR 0007): the home screen, adding (your own, a kid's, or a suggestion), changing, approving, ordering.
// Who may do what is wishes/wishes.ts's; what comes back is the view layer's.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { MAX_WISHES, type Data, type WishInput } from '../data';
import { Refused } from '../errors';
import { bool, id, ids, int, link, nullableId, nullableInt, nullableText, object, text, type Body } from '../validate';

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

export async function wishRoutes(app: FastifyInstance, _cfg: Config, data: Data) {
  const me = (req: FastifyRequest) => req.caller!.person;
  const view = (req: FastifyRequest) => data.view(me(req));

  app.get('/home', async (req) => view(req).home(data.listFor(req.query)));

  app.post('/wishes', async (req, reply) => {
    const b = object(req.body, ['personId', ...FIELDS]);
    const personId = id(b, 'personId', { required: true })!;
    const f = fields(b, true);
    const w = data.wishes.add(me(req), personId, {
      name: f.name!, link: f.link ?? null, priceMinor: f.priceMinor ?? null, quantity: f.quantity ?? 1, note: f.note ?? null,
      mostWanted: f.mostWanted ?? false, celebrationId: f.celebrationId ?? null,
    });
    return reply.code(201).send(view(req).wish(w));
  });

  app.patch<W>('/wishes/:wishId', async (req) => view(req).wish(data.wishes.edit(me(req), req.params.wishId, fields(object(req.body, FIELDS), false))));

  app.delete<W>('/wishes/:wishId', async (req, reply) => {
    data.wishes.remove(me(req), req.params.wishId);
    return reply.code(204).send();
  });

  app.post<W>('/wishes/:wishId/approve', async (req) => view(req).wish(data.wishes.approve(me(req), req.params.wishId)));

  app.post<W>('/wishes/:wishId/decline', async (req, reply) => {
    data.wishes.decline(me(req), req.params.wishId);
    return reply.code(204).send();
  });

  app.put<{ Params: { personId: string } }>('/people/:personId/wish-order', async (req, reply) => {
    const list = ids(object(req.body, ['wishIds']), 'wishIds', { max: MAX_WISHES });
    if (!list) throw new Refused(400, 'wishIds: required');
    data.wishes.order(me(req), req.params.personId, list);
    return reply.code(204).send();
  });
}
