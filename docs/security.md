# Security: threat model (draft)

Keepsake holds a household's wishes, who is giving what to whom, and its kids' lists. Its one promise beyond keeping
that private is the surprise: the person a gift is for must not learn it from Keepsake (ADR 0003, 0004).

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Wishes, prices, notes, kids' lists | SQLite | private to the household; kids especially |
| Claims and "bought" marks | SQLite | the surprise: never to the person a wish is for |
| Ideas kept for someone, group-gift shares | SQLite | the surprise |
| Who asked a question | SQLite | anonymity (ADR 0008) |
| Exchange assignments | sealed per giver; key outside the database | nobody may list the whole draw |
| Sessions, invite links, guest links | hashed in SQLite | sign-in, guest access |

## Actors and what stops them

| Actor | Could try | Controls |
|---|---|---|
| **The person a gift is for** | read claims, shares or ideas for their wishes, or who asked them: page data, API, live updates, filters, sort order, counts, "gone" flags, error messages, export, the arrival time of a question | ADR 0003: one view layer, claims and shares removed before any filter/sort/count, no claim stream to the person; questions batched to the morning (ADR 0008); a viewer × wish matrix of raw-response tests |
| **A curious adult, host or admin** | list the whole draw before the reveal; learn who asked | ADR 0004: sealed per giver, no route lists pairs, audit without pairs; ADR 0008: asker read only by `viewFor` |
| **A kid** | see their own claims; make their list public | kids are "meant for" on their list; public only with an adult's approval |
| **A stranger on the LAN / internet** | reach the app, forge identity headers, take over an empty install | identity headers only from the configured proxy and only once the edge strips them; standalone binds 127.0.0.1; no first-visitor admin: the first admin comes from HomersLab's roles or a one-time setup link in the data folder (Philobiblos ADR 0010) |
| **Another website** | CSRF | SameSite=Strict; Origin required on every change; `frame-ancestors 'none'` |
| **A hostile shop page** (add from a link, M5) | SSRF, huge or scripted pages, decoder exploits | Philobiblos' egress client (allowlist, public addresses only, size and time caps) and media worker (pictures re-encoded) |
| **Whoever holds a guest link** | reach other people or draws; keep using it after the celebration | ADR 0009: one person or one draw only; claims, questions and a name only; draw links expire after the celebration; revocable; hashed at rest; token in the fragment; a kid's wishes only with a parent's approval |
| **Someone with a backup** | read the draw | sealed with a key that is not in the database or its backup |

## Rules

Each new route, job or import states its actor and control here before it merges (ADR 0006).

## Routes

| Route | Actor | Control |
|---|---|---|
| `GET /api/health` (M0) | anyone who reaches the app | public by design; answers only `ok`, the version and the mode, nothing of the household; every response carries the CSP (`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP same-origin (`apps/server/src/security-headers.ts`); standalone binds 127.0.0.1 and compose publishes on 127.0.0.1 only |
| `GET /*` (web app: the build's files and the page fallback) | anyone who reaches the app | the build output only (`KEEPSAKE_WEB_DIR`), served file by file (no wildcard, no dotfiles), no household data, the same headers; `index.html` only for a GET or HEAD outside `/api` and `/assets/`; anything else (another method, `/api`, `/api?…`, an unknown `/api/…` or `/assets/…` path) is the JSON 404, and `/api` answers `no-store` (`apps/server/src/paths.ts`) |

## For M1: identity

M0 reads no identity, so `homerslab` mode starts without `KEEPSAKE_TRUSTED_PROXY`, `KEEPSAKE_EDGE_IDENTITY` and
`KEEPSAKE_ORIGIN`. When M1 adds them:

- trust `X-HomersLab-*` only when `req.socket.remoteAddress` (with `::ffff:` normalised) is the configured proxy; keep
  `trustProxy: false`, never use `req.ip` or `X-Forwarded-*`;
- drop every `X-HomersLab-*` header from any other source;
- refuse to start in `homerslab` mode without all three, as the manifest promises;
- the smoke test's stand-in `KEEPSAKE_TRUSTED_PROXY=127.0.0.1` is not the source address behind `-p` (docker-proxy or
  the bridge's gateway): M1's smoke test uses the real address, or probes only public routes;
- the logger's redaction lists `x-homerslab-person` and `x-homerslab-name`: add `x-homerslab-role` (inert today, as
  Fastify's request serializer logs no headers, but complete if header logging is turned on).
