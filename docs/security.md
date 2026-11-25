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
| `GET /api/auth/session` (M1) | anyone who reaches the app | says only whether the caller is signed in (and as whom) and, standalone, whether the first admin is still missing; under HomersLab the person only from the trusted proxy |
| `POST /api/auth/enrol/options`, `/api/auth/enrol/verify` (M1) | whoever holds a one-time link | standalone only (404 under HomersLab); the token (256 bits, in the link's `#fragment`, SHA-256 at rest) must be unused and unexpired; the setup link is written to `KEEPSAKE_DATA_DIR/setup-link.txt` (0600, `O_EXCL`/`O_NOFOLLOW`, never logged), so the first admin is whoever can read the data folder, never the first visitor; an admin's invite only for someone without a passkey; user verification required, challenges one-time and 5 minutes; Origin; 20 a minute per address |
| `POST /api/auth/sign-in/options`, `/api/auth/sign-in/verify` (M1) | anyone who reaches the app | standalone only; a passkey with user verification and the signature counter; one answer for every failure; Origin; 20 a minute per address; the session cookie `keepsake_session` is HttpOnly, Secure, SameSite=Strict, 256 bits, SHA-256 at rest, 30 days / 7 idle |
| `POST /api/auth/sign-out` (M1) | anyone | ends this browser's session only; Origin |
| `POST /api/me/passkeys/invite` (M1) | a signed-in person (standalone) | a link for their own other device only; needs a sign-in of the last 10 minutes (a stolen older cookie cannot add a passkey); Origin |
| `GET /api/household` (M1) | everyone in the household | names, roles, kids' parents, whether someone has a passkey, the currency; nothing secret (no tokens, keys or hashes) |
| `PATCH /api/household` (M1) | admins | the currency only (ISO 4217); no security setting lives in the database |
| `POST /api/people`, `PATCH`/`DELETE /api/people/{id}` (M1) | admins, standalone | 409 under HomersLab (people are HomersLab's); the last admin who can sign in stays; nobody removes themselves |
| `PUT /api/people/{id}/managers` (M1) | admins | a kid's parents: grown-ups of the household only; none set means the admins, so a kid's wish never waits for nobody |
| `POST /api/people/{id}/invites` (M1) | admins, standalone | only for someone without a passkey; a sign-in of the last 10 minutes; the link shown once, hashed at rest, 7 days |
| `GET /api/people/{id}` (M1) | everyone in the household | built by `viewFor(viewer)`: hidden wishes (a kid's waiting ones, suggestions) removed before the `for` filter and the order; profile and celebrations |
| `PUT /api/people/{id}/profile` (M1) | the person, a kid's parent | `keeps()`; fields checked, sizes/likes/please-no capped in count and length |
| `PUT /api/people/{id}/wish-order` (M1) | the person, a kid's parent | exactly their listed and waiting wishes, each once |
| `GET /api/home` (M1) | everyone in the household | `viewFor(viewer)`; their own wishes, suggestions for them, approvals waiting for them, their own suggestions; nothing of anyone else's that is hidden from them |
| `POST /api/wishes` (M1) | everyone in the household | the state decides who sees it: the person's own is listed (a kid's waits for a parent), a parent's for their kid is listed, anyone else's is a suggestion; the celebration must include the person; the link is checked (http/https, no credentials, 2000 characters) and stored, never fetched (no outgoing connection exists, `test/architecture.test.ts`) |
| `PATCH`/`DELETE /api/wishes/{id}` (M1) | the keeper; a suggestion's author while it waits | a wish the caller may not see is a 404 like one that does not exist; a kid's change to a listed wish goes back to a parent |
| `POST /api/wishes/{id}/approve`, `/api/wishes/{id}/decline` (M1) | a suggestion's person or a kid's parent; a kid's waiting wish, its parent | `canApprove()`; a kid's yes to a suggestion still waits for a parent; hidden wishes 404 |
| `GET /api/celebrations`, `GET /api/celebrations/{id}` (M1) | everyone in the household | `viewFor(viewer)`; each person's list computed after the visibility filter; `toApprove` counts only the caller's own approvals |
| `POST /api/celebrations` (M1) | grown-ups | the caller hosts; people must be in the household |
| `PATCH`/`DELETE /api/celebrations/{id}` (M1) | its host, admins | someone taken out keeps their wishes for any time; a removed celebration's wishes stay, for any time |

Every `/api` route but `/health` needs a person (deny by default); every change (anything but GET/HEAD/OPTIONS)
must carry `KEEPSAKE_ORIGIN` as its Origin, public sign-in steps included. Every answer below 400 must come from the
view layer (`apps/server/src/view/view.ts`): the API refuses any other with a 500, and the architecture test keeps
routes away from the schema, Drizzle and SQLite.

## Identity (M1)

- `homerslab` mode refuses to start without `KEEPSAKE_ORIGIN`, `KEEPSAKE_TRUSTED_PROXY` and
  `KEEPSAKE_EDGE_IDENTITY=homerslab-v1` (`apps/server/src/config.ts`; the smoke test starts it without them).
- `X-HomersLab-*` count only when `req.socket.remoteAddress` (with `::ffff:` normalised) is the configured proxy;
  `trustProxy: false`, never `req.ip` or `X-Forwarded-*`. From any other source every `X-HomersLab-*` header is
  deleted in the first hook. A repeated person header, or a role other than exactly `admin`, `adult` or `kid`, is
  refused (403 for a missing or wrong role). A session cookie means nothing under HomersLab; a HomersLab header means
  nothing standalone.
- The smoke test's stand-in `KEEPSAKE_TRUSTED_PROXY=127.0.0.1` is not the source address behind `-p`, so it probes
  that a forged identity through `-p` gets 401, and public routes only otherwise.
- The logger redacts `authorization`, `cookie`, `x-homerslab-person`, `x-homerslab-name` and `x-homerslab-role`.
- Kids sign in (their own passkey standalone, their role under HomersLab). Who manages a kid is Keepsake's own in both
  modes until HomersLab's household API gives it.
