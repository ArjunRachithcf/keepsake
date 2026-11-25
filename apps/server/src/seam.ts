// ADR 0003's seam, at run time. Every /api answer below 400 with a body must be one the view layer built: the flag
// is set only when the object Fastify is about to serialize is a viewed (and frozen) answer, and the last hook before
// the bytes leave (onSend) refuses anything else with a 500: a string, a Buffer, a stream, an object that bypassed the
// view. Answers of 400 and above carry only `{ error }`. (`reply.hijack()` and `reply.raw` skip hooks: the routes may
// not use them, test/architecture.test.ts.)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Refused } from './errors';
import { isViewed } from './view/view';

declare module 'fastify' {
  interface FastifyRequest { viewed: boolean }
}

const REFUSED = JSON.stringify({ error: 'something went wrong' });

function isErrorBody(payload: unknown): boolean {
  if (typeof payload !== 'string') return false;
  try {
    const v = JSON.parse(payload) as unknown;
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 1 && typeof (v as { error?: unknown }).error === 'string';
  } catch { return false; }
}

const empty = (payload: unknown) => payload === undefined || payload === null || payload === '' || (Buffer.isBuffer(payload) && payload.length === 0);

/** The guard as a function (tested on its own and installed by installSeam). */
export async function guardAnswer(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  const ok = reply.statusCode >= 400 ? empty(payload) || isErrorBody(payload) : empty(payload) || req.viewed === true;
  if (ok) return payload;
  (payload as { destroy?: () => void } | null)?.destroy?.();
  req.log.error({ url: req.routeOptions.url, status: reply.statusCode }, 'an answer that did not come from the view layer');
  if (reply.statusCode < 400) void reply.code(500);
  void reply.type('application/json; charset=utf-8');
  return REFUSED;
}

export function installSeam(api: FastifyInstance): void {
  api.decorateRequest('viewed', false);
  api.addHook('preSerialization', async (req, _reply, payload) => {
    if (isViewed(payload)) req.viewed = true;
    return payload;
  });
  api.addHook('onSend', guardAnswer);
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'too many tries; wait a minute' });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 415 ? 'send JSON' : 'the request is not valid' });
    req.log.error(err);
    return reply.code(500).send({ error: 'something went wrong' });
  });
}
