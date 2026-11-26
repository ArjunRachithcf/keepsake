// The API client: same origin, cookies only (the session is HttpOnly), JSON in and out. Errors carry the server's
// message, which is written for people to read. The browser adds the Origin header every change needs.
export type * from '@keepsake/contracts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The guest link this page is for (ADR 0009, review M-a): every guest request names it, since one browser may hold several. */
let guestLink: string | null = null;
export const setGuestLink = (id: string | null) => { guestLink = id; };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = init.body === undefined ? {} : { 'content-type': 'application/json' };
  if (guestLink && path.startsWith('/guest') && path !== '/guest/session') headers['x-keepsake-link'] = guestLink;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? (res.status === 429 ? 'Too many tries; wait a minute.' : 'Something went wrong.'));
  }
  return data as T;
}

// The server writes its messages in lower case, to fit in a sentence; on their own they start with a capital.
export const message = (e: unknown) => {
  const m = e instanceof Error && e.message ? e.message : 'Something went wrong.';
  return m.charAt(0).toUpperCase() + m.slice(1);
};
