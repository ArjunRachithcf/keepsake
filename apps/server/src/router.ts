// The narrow router route files get instead of the Fastify instance (ADR 0003). A route says its method, its path,
// whether it is public or a sign-in step, and a handler that gets an opaque request and returns a view answer (or
// nothing, for a 204). It never sees Fastify's request or reply: no socket, no raw stream, no headers, no hooks, no
// serializer, no redirect. Status codes, the session cookie and rate limits are this module's; what goes out is the
// seam's to check (src/seam.ts), and the seam refuses at start-up any /api route that was not made here.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, SESSION_DAYS, cookieOptions } from './auth/sessions';
import { GUEST_COOKIE } from './guests/guests';
import type { Viewed } from './view/view';

/** A request as a route sees it: path parameters, query and body, nothing else. */
export interface Req<P extends string = string> {
  readonly params: Readonly<Record<P, string>>;
  readonly query: unknown;
  readonly body: unknown;
}

/** What a route may do to its answer besides returning it. */
export interface Res {
  /** Answer 201 instead of 200. */
  created(): void;
  /** Set this browser's session cookie (after a sign-in). */
  startSession(token: string): void;
  /** Clear this browser's session cookie. */
  endSession(): void;
  /** Set this browser's guest session cookie (after a link's token was exchanged, ADR 0009). */
  startGuest(token: string, maxAgeSeconds: number): void;
  /** Clear this browser's guest session cookie. */
  endGuest(): void;
}

type Answer = Viewed | undefined | void;
export type Handler<P extends string> = (r: Req<P>, res: Res) => Answer | Promise<Answer>;

/**
 * A route's options: public (no person needed); a sign-in step (rate limited, docs/security.md); a guest's route (the
 * guest session instead of a person, ADR 0009); a larger body (the sheet import).
 */
export interface RouteOptions { public?: true; signIn?: true; guest?: true; bodyLimit?: number }

/** The path parameters a path names (`/people/:personId` → 'personId'). */
type ParamsOf<S extends string> = S extends `${string}:${infer P}/${infer R}` ? P | ParamsOf<`/${R}`> : S extends `${string}:${infer P}` ? P : never;

type Add = {
  <S extends string>(path: S, h: Handler<ParamsOf<S>>): void;
  <S extends string>(path: S, o: RouteOptions, h: Handler<ParamsOf<S>>): void;
};
export interface Router { get: Add; post: Add; put: Add; patch: Add; delete: Add }

const REQUESTS = new WeakMap<object, FastifyRequest>();
const HANDLERS = new WeakSet<object>();

/** Fastify's request behind a route's (for data.ts: the viewer, the session cookie, the client's address). */
export function fastifyRequestOf(r: Req): FastifyRequest {
  const req = REQUESTS.get(r);
  if (!req) throw new Error('router: not a request the router made');
  return req;
}

/** Whether a Fastify route's handler is one this router made (src/seam.ts refuses every other /api route). */
export const isRouted = (handler: unknown): boolean => typeof handler === 'function' && HANDLERS.has(handler);

export function routerFor(api: FastifyInstance, signInLimit: object): Router {
  const add = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'): Add => ((path: string, a: RouteOptions | Handler<string>, b?: Handler<string>) => {
    const [o, h] = typeof a === 'function' ? [{} as RouteOptions, a] : [a, b!];
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const r: Req = Object.freeze({ params: Object.freeze({ ...(req.params as Record<string, string>) }), query: req.query, body: req.body });
      REQUESTS.set(r, req);
      let status = 200;
      const res: Res = Object.freeze({
        created: () => { status = 201; },
        startSession: (token: string) => void reply.setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86_400)),
        endSession: () => void reply.clearCookie(SESSION_COOKIE, { path: '/' }),
        startGuest: (token: string, maxAge: number) => void reply.setCookie(GUEST_COOKIE, token, cookieOptions(maxAge)),
        endGuest: () => void reply.clearCookie(GUEST_COOKIE, { path: '/' }),
      });
      const out = await h(r, res);
      return out === undefined ? reply.code(204).send() : reply.code(status).send(out);
    };
    HANDLERS.add(handler);
    api.route({
      method, url: path, handler, exposeHeadRoute: false, ...(o.bodyLimit ? { bodyLimit: o.bodyLimit } : {}),
      config: { auth: o.public ? 'public' : o.guest ? 'guest' : 'person', signIn: Boolean(o.signIn), ...(o.signIn ? { rateLimit: signInLimit } : {}) },
    });
  }) as Add;
  return Object.freeze({ get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') });
}
