// ADR 0003's seam, at run time, for every /api answer:
// - below 400 with a body: the bytes Fastify is about to send must be exactly the serialization of a view answer built
//   for this request, as this module recorded it before serializing (a private WeakMap, out of the routes' reach). A
//   string, a Buffer, a stream, a copy, an answer built for another request, or anything changed after the view built
//   it is refused with a 500;
// - 3xx: refused (Keepsake's API never redirects);
// - 400 and above: `{ error }` only, the message from the fixed catalogue (src/errors.ts);
// - headers: only the names below, and no cookie but the session's.
// Both hooks sit on each route (installSeam's onRoute), so they run after every scope-level hook.
// At start-up it refuses any /api route not made by the router (src/router.ts), and any route-level hook, serializer or
// error handler. This guards against mistakes in our own code, not against deliberately hostile code in the server:
// test/architecture.test.ts's source bans (no Fastify, raw request, socket or reply in a route file) are the backstop.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from './auth/sessions';
import { isCatalogued, Refused } from './errors';
import { isRouted } from './router';
import { SECURITY_HEADERS } from './security-headers';
import { builtFor } from './view/view';

const RECORDED = new WeakMap<FastifyRequest, string>();
const REFUSED = JSON.stringify({ error: 'something went wrong' });

/** The response headers an /api answer may carry. */
export const API_HEADERS = new Set([
  'content-type', 'content-length', 'cache-control', 'set-cookie', 'connection',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after',
  ...Object.keys(SECURITY_HEADERS).map((h) => h.toLowerCase()),
]);

/** What a route may not set on itself: hooks, serializers, its own error handler. */
const ROUTE_LEVEL = ['preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onResponse', 'onError', 'onTimeout', 'onRequestAbort', 'errorHandler', 'serializerCompiler', 'childLoggerFactory'] as const;

function errorBody(payload: unknown): boolean {
  if (typeof payload !== 'string') return false;
  try {
    const v = JSON.parse(payload) as unknown;
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 1 && isCatalogued((v as { error?: unknown }).error);
  } catch { return false; }
}

const empty = (payload: unknown) => payload === undefined || payload === null || payload === '' || (Buffer.isBuffer(payload) && payload.length === 0);
const isJson = (reply: FastifyReply) => /^application\/json(?:;|$)/.test(String(reply.getHeader('content-type') ?? ''));

/** Why an answer may not leave, or null when it may. */
function wrong(req: FastifyRequest, reply: FastifyReply, payload: unknown): string | null {
  const status = reply.statusCode;
  const extra = Object.keys(reply.getHeaders()).filter((h) => !API_HEADERS.has(h.toLowerCase()));
  if (extra.length) return `headers ${extra.join(', ')}`;
  const cookies = [reply.getHeader('set-cookie') ?? []].flat().map(String);
  if (cookies.some((c) => !c.startsWith(`${SESSION_COOKIE}=`))) return 'a cookie other than the session';
  if (status >= 300 && status < 400) return 'a redirect';
  if (empty(payload)) return null;
  if (!isJson(reply)) return 'not JSON';
  if (status >= 400) return errorBody(payload) ? null : 'an error body outside the catalogue';
  const recorded = RECORDED.get(req);
  return typeof payload === 'string' && recorded !== undefined && payload === recorded ? null : 'an answer that did not come from the view layer';
}

/** The guard as a function (installed by installSeam as the API's last onSend hook). */
export async function guardAnswer(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  const why = wrong(req, reply, payload);
  if (!why) return payload;
  (payload as { destroy?: () => void } | null)?.destroy?.();
  req.log.error({ url: req.routeOptions.url, status: reply.statusCode, why }, 'an answer refused at the seam');
  for (const h of Object.keys(reply.getHeaders())) if (!API_HEADERS.has(h.toLowerCase()) || h.toLowerCase() === 'set-cookie') reply.removeHeader(h);
  void reply.code(500).type('application/json; charset=utf-8');
  return REFUSED;
}

/** Records the bytes a view answer built for this very request serializes to (an answer built for another is not). */
async function record(req: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> {
  // Fastify serializes with JSON.stringify (no route may bring a serializer or a response schema): this string is
  // what has to leave.
  if (builtFor(payload) === req) RECORDED.set(req, JSON.stringify(payload));
  return payload;
}

export function installSeam(api: FastifyInstance): void {
  api.addHook('onRoute', (r) => {
    if (!isRouted(r.handler)) throw new Error(`${r.url}: an /api route must come from the router (src/router.ts)`);
    for (const k of ROUTE_LEVEL) if ((r as unknown as Record<string, unknown>)[k]) throw new Error(`${r.url}: no route-level ${k}`);
    if (r.schema?.response) throw new Error(`${r.url}: no response schema (Fastify would serialize the answer itself)`);
    // The only route-level onRequest is the rate limit's, on the sign-in steps.
    if (r.onRequest && !r.config?.signIn) throw new Error(`${r.url}: no route-level onRequest`);
    // On the route itself: route-level hooks run after every scope's, and no other route-level one exists, so the
    // recording is the last preSerialization and the guard the last onSend, whatever hooks the scopes add.
    r.preSerialization = [record];
    r.onSend = [guardAnswer];
  });
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof Refused) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'too many tries; wait a minute' });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 415 ? 'send JSON' : 'the request is not valid' });
    req.log.error(err);
    return reply.code(500).send({ error: 'something went wrong' });
  });
}
