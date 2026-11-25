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
| Draw assignments | `draw_assignment`: sealed per giver (AES-256-GCM), the key outside the database (`KEEPSAKE_SEALING_KEY`, or the standalone key file in `keys/`) | nobody may list the whole draw before the host's reveal date; a backup alone must say nothing |
| The sealing key | `KEEPSAKE_SEALING_KEY` / `_FILE`, or `keys/sealing.key` (0600, made once) | whoever holds it and a copy of the database can open every draw: kept apart from `data/` and its backups |
| Sessions, invite links, guest links | hashed in SQLite | sign-in, guest access |

## Actors and what stops them

| Actor | Could try | Controls |
|---|---|---|
| **The person a gift is for** | read claims, shares or ideas for their wishes, or who asked them: page data, API, live updates, filters, sort order, counts, "gone" flags, error messages, export, the arrival time of a question | ADR 0003: one view layer, claims and shares removed before any filter/sort/count, no claim stream to the person; questions batched to the morning (ADR 0008); a viewer × wish matrix of raw-response tests |
| **A curious adult, host or admin** | list the whole draw before the reveal; learn who asked | ADR 0004: sealed per giver, no route lists pairs, audit without pairs; every answer before the reveal is byte for byte the same whoever the others drew (`test/draws.test.ts`); ADR 0008: asker read only by `viewFor` |
| **The host probing the rules** | with "not last year's person" on, try exclusions until a draw is refused, to learn something of last year's pairs | **closed** (PR #10 review M1): whether a draw may be made is decided from the participants and the exclusions alone; with the rule on, everyone must keep ⌈n/2⌉+1 people they may draw, so last year's pairs can never block it (Hall) and every last year gets the same answer (`test/draws.test.ts`). The one exception, accepted: above 16 people, rejection sampling's "too few ways" within its 300 ms can depend slightly on last year. Tries: 20 a day per celebration and year (`draw_try`), so removing and re-making a draw does not reset them |
| **A host or giver reasoning from the rules** | build exclusions under which a pair is certain, or with which knowing one's own person tells another's (two couples among four, a single possible draw, three people; four with "not last year's person" once last year is known) | at least 4 people, 5 with "not last year's person" (from the settings alone); rules that let anyone work out another's person are refused (exactly up to 16 people, a degree rule above; ADR 0004) |
| **Any giver watching gifts** | read who claimed or chipped in on whose wish ("Sam claimed Robin's wish" = "Sam drew Robin"), also after the draw or its celebration is removed | while a draw is drawn and not revealed, gifts by its people to each other (made up to its day, in the household's time zone) name no giver to anyone but the giver; counts stay; a draw that goes, or whose people change, leaves a veil (its people and day, no pairs) that keeps doing so until its reveal date, or for good with "never" (`draw_veil`; in the byte matrix, removal included) |
| **A host moving the celebration** | move it earlier to bring the reveal before the day, then back | a drawn draw's day is stored at drawing and only moves later; moving it earlier is refused; a reveal is latched once it happens; date changes are audited (`draw_moved`) |
| **A kid** | see their own claims; make their list public | kids are "meant for" on their list; public only with an adult's approval |
| **A stranger on the LAN / internet** | reach the app, forge identity headers, take over an empty install | identity headers only from the configured proxy and only once the edge strips them; standalone binds 127.0.0.1; no first-visitor admin: the first admin comes from HomersLab's roles or a one-time setup link in the data folder (Philobiblos ADR 0010) |
| **Another website** | CSRF | SameSite=Strict; Origin required on every change; `frame-ancestors 'none'` |
| **A hostile shop page** (add from a link, M5) | SSRF, huge or scripted pages, decoder exploits | Philobiblos' egress client (allowlist, public addresses only, size and time caps) and media worker (pictures re-encoded) |
| **Whoever holds a guest link** | reach other people or draws; keep using it after the celebration | ADR 0009: one person or one draw only; claims, questions and a name only; draw links expire after the celebration; revocable; hashed at rest; token in the fragment; a kid's wishes only with a parent's approval |
| **Someone with a backup** | read the draw | sealed with a key that is not in the database or its backup; each row bound to its draw and giver (associated data) and padded to one length, written in the givers' order: the raw tables of two households with different pairs differ only in the sealed bytes (`test/draws.test.ts`) |

## Rules

Each new route, job or import states its actor and control here before it merges (ADR 0006).

## Routes

| Route | Actor | Control |
|---|---|---|
| `GET /api/health` (M0) | anyone who reaches the app | public by design; answers only `ok`, the version and the mode, nothing of the household; every response carries the CSP (`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP same-origin (`apps/server/src/security-headers.ts`); standalone binds 127.0.0.1 and compose publishes on 127.0.0.1 only |
| `GET /*` (web app: the build's files and the page fallback) | anyone who reaches the app | the build output only (`KEEPSAKE_WEB_DIR`), served file by file (no wildcard, no dotfiles), no household data, the same headers; `index.html` only for a GET or HEAD outside `/api` and `/assets/`; anything else (another method, `/api`, `/api?…`, an unknown `/api/…` or `/assets/…` path) is the JSON 404, and `/api` answers `no-store` (`apps/server/src/paths.ts`) |
| `GET /api/auth/session` (M1) | anyone who reaches the app | says only whether the caller is signed in (and as whom) and, standalone, whether the first admin is still missing; under HomersLab the person only from the trusted proxy |
| `POST /api/auth/enrol/options`, `/api/auth/enrol/verify` (M1) | whoever holds a one-time link | standalone only (404 under HomersLab); the token (256 bits, in the link's `#fragment`, SHA-256 at rest) must be unused and unexpired; the setup link is written to `KEEPSAKE_DATA_DIR/setup-link.txt` (0600, `O_EXCL`/`O_NOFOLLOW`, never logged), so the first admin is whoever can read the data folder, never the first visitor; the link is checked again (unused, unexpired) inside the last step's transaction; an admin's invite only for someone without a passkey; a recovery link removes the admin's other passkeys, ends their sessions and deletes their unused invites; the first admin's WebAuthn user handle is their person id; user verification required, challenges one-time and 5 minutes; Origin; the sign-in limits below |
| `POST /api/auth/sign-in/options`, `/api/auth/sign-in/verify` (M1) | anyone who reaches the app | standalone only; a passkey with user verification and the signature counter; one answer for every failure; Origin; the sign-in limits below; the session cookie `keepsake_session` is HttpOnly, Secure, SameSite=Strict, 256 bits, SHA-256 at rest, 30 days / 7 idle |
| `POST /api/auth/sign-out` (M1) | anyone | ends this browser's session only; Origin |
| `POST /api/me/passkeys/invite` (M1) | a signed-in person (standalone) | a link for their own other device only; needs a sign-in of the last 10 minutes (a stolen older cookie cannot add a passkey); Origin |
| `GET /api/me/passkeys`, `DELETE /api/me/passkeys/{id}` (M1) | a signed-in person (standalone) | their own passkeys only (another's id is a 404); removing one ends the sessions it signed in; the last one stays (409) |
| `POST /api/me/sessions/end` (M1) | a signed-in person (standalone) | "Sign out everywhere": every session of theirs ends, this one too |
| `POST /api/people/{id}/sessions/end` (M1) | a kid's parent, admins (standalone) | after a lost device: every session of that person ends; their passkeys stay (a device lock guards them) |
| `POST /api/people/{id}/passkeys/reset` (M1) | admins (standalone) | every device lost: the person's passkeys go, their sessions end and their open links are spent, then the admin sends the usual invite; needs a passkey sign-in of the last 5 minutes; never an admin's (409: an admin recovers with `keepsake recover`); a row in the `audit` table (who, whom, when) |
| `GET /api/household` (M1) | everyone in the household | names, roles, kids' parents, whether someone has a passkey, the currency; nothing secret (no tokens, keys or hashes) |
| `PATCH /api/household` (M1) | admins | the currency only (ISO 4217); no security setting lives in the database |
| `POST /api/people`, `PATCH`/`DELETE /api/people/{id}` (M1) | admins, standalone | 409 under HomersLab (people are HomersLab's); the last admin who can sign in stays; nobody removes themselves; someone in a drawn draw before its day leaves it under the re-draw rules in the same transaction (the others drawn again and told, or the draw back to not drawn), else 409 (ADR 0004) |
| `PUT /api/people/{id}/managers` (M1) | admins | a kid's parents: grown-ups of the household only; none set means the admins, so a kid's wish never waits for nobody |
| `POST /api/people/{id}/invites` (M1) | admins, standalone | only for someone without a passkey; a sign-in of the last 10 minutes; the link shown once, hashed at rest, 7 days |
| `GET /api/people/{id}` (M1) | everyone in the household | built by `viewFor(viewer)`: hidden wishes (a kid's waiting ones, suggestions) removed before the `for` filter and the order; profile and celebrations |
| `PUT /api/people/{id}/profile` (M1) | the person, a kid's parent | `keeps()`; fields checked, sizes/likes/please-no capped in count and length |
| `PUT /api/people/{id}/wish-order` (M1) | the person, a kid's parent | exactly their listed and waiting wishes, each once |
| `GET /api/home` (M1, M2) | everyone in the household | `viewFor(viewer)`; their own wishes, suggestions for them, approvals waiting for them, their own suggestions; nothing of anyone else's that is hidden from them; their own wishes never carry gifts; after a celebration, `thanks` (gifts they received, and for a kid's parents the kid's, naming only givers who chose it; never before the occasion is over) and `gave` (gifts they gave, to put their name on) |
| `POST /api/wishes` (M1) | everyone in the household | the state decides who sees it: the person's own is listed (a kid's waits for a parent), a parent's for their kid is listed, anyone else's is a suggestion; the celebration must include the person; the link is checked (http/https, no credentials, 2000 characters) and stored, never fetched (no outgoing connection exists, `test/architecture.test.ts`) |
| (limits on wishes) | everyone in the household | a list holds 300 wishes (adding or saying yes to a suggestion beyond that is a 409); one person keeps at most 30 suggestions waiting for another (409), so nobody floods someone's inbox |
| `PATCH`/`DELETE /api/wishes/{id}` (M1) | the keeper; a suggestion's author while it waits | a wish the caller may not see is a 404 like one that does not exist; a kid's change to a listed wish goes back to a parent |
| `POST /api/wishes/{id}/approve`, `/api/wishes/{id}/decline` (M1) | a suggestion's person or a kid's parent; a kid's waiting wish, its parent | `canApprove()`; a kid's yes to a suggestion still waits for a parent; hidden wishes 404 |
| (gifts in every answer, M2) | everyone in the household | `viewFor(viewer)` gives a wish its gifts (`gift`) only when the viewer is a **giver**: not its person and not a kid (PR #8: kids see no claims or shares of anyone, so nothing spoils through a kid); a kid's parents and the admins see a kid's. For everyone else the field is absent and no gift is read: their answers are byte for byte the answers with no gifts, until the celebration is over (`test/gifts.test.ts`, every reading route (`/household` and `/me/passkeys` included), bodies and headers × person, parent, other adult, kid, admin, givers × claimed, bought, given, partly given, group gift, a late gift, after the occasion with and without a name, a celebration postponed or removed after the gift, the wish moved later or to any time after it, revealed then the date corrected, the giver removed (claimed, bought, after the occasion); compared byte for byte with a twin household that has the same changes and no gifts, the clock pinned so both make them at the same moment). Gifts are cut before the list's other steps: "gone" (a giver: all given; the person and kids: given **and** the celebration over), the `for` filter, the order and the counts. Others' shares are names only (the total and the target, never another giver's amount). Nothing a giver does changes the wish's own row, so its `updatedAt`, order or celebration never move for the person; no stream or push carries gifts. A giver removed from the household takes their claims that are only claimed and their shares of group gifts not yet given along; bought and given ones stay, without a giver and never named. What the household has received is rebuilt once a day and in every request that changes something; a person's reading requests only look it up |
| `PUT`/`PATCH`/`DELETE /api/wishes/{id}/claim` (M2) | givers | "I'll get this" (how many, within what is left; not on a group gift), bought, given, back; a hidden wish 404s like a missing one; the person and kids get a 403 decided from the wish and the caller alone, before any gift is read, so their answer never depends on the gifts; when a given gift reaches its person is the day after the latest of the occasion kept when it was marked given, the wish's current occasion (read now) and the day it was given (ADR 0003): it only ever moves later; once its person has it, it is latched (`revealed_on`) and stays given; unclaiming a given one is a 409 |
| `PUT /api/wishes/{id}/named` (M2) | givers | only for a gift the caller gave, once its celebration is over (409 otherwise); off by default; the person's thank-yous (`GET /api/home` `thanks`) then name that giver, and only those who chose it; the others stay hidden for good |
| `POST`/`PATCH`/`DELETE /api/wishes/{id}/group` (M2) | givers; changes by whoever started it (if they left, anyone who chipped in) | the same 403/404 as claims; not on a wish someone has claimed; the household's currency first; the target changes only while open; ending only while nobody else has chipped in |
| `PUT`/`DELETE /api/wishes/{id}/group/share` (M2) | givers | the same 403/404 as claims; while the group gift is open; all shares together at most the target (409), and the target never below them; one share per giver, amounts 1 to 100 000 000 minor units; others see the caller's name, never the amount |
| `GET /api/celebrations`, `GET /api/celebrations/{id}` (M1) | everyone in the household | `viewFor(viewer)`; each person's list computed after the visibility filter; `toApprove` counts only the caller's own approvals |
| `POST /api/celebrations` (M1) | grown-ups | the caller hosts; people must be in the household |
| `PATCH`/`DELETE /api/celebrations/{id}` (M1) | its host, admins | someone taken out keeps their wishes for any time; a removed celebration's wishes stay, for any time (and its draws go); someone in a drawn draw whose day has not come stays until the draw changes (409), in a draw not drawn yet they just leave it; a drawn draw's day only moves later (409 otherwise; `draw_moved` audited); a celebration with a drawn draw goes before its day only under the re-draw rules |
| `GET /api/celebrations/{id}/draw` (M3) | everyone in the household | `viewFor(viewer)`: who is in it, its settings, "4 of 6 opened" (counts, never who); the exclusions to its host only (`null` for everyone else); the caller's own person only once they opened theirs (only their own sealed row is opened); every pair only from the reveal date on (a day after the celebration, never by default), and only to the participants and the host. Before the reveal, each viewer's answers to every reading route are byte for byte the same whoever the others drew, the host and admins included (`test/draws.test.ts`, 7 viewers × 7 states). Celebrations carry a short `draw` (counts and the caller's own state, no pairs) |
| `POST`/`PATCH`/`DELETE /api/celebrations/{id}/draw` (M3) | the celebration's host (an admin when it has none; never a kid) | 403 for anyone else, also in the facade; who draws must be in the celebration, kids only with "Kids draw too"; exclusions pairs of them; a budget needs the currency; the reveal a day after the celebration or never, and once it has happened it stays (409); once drawn, a change to who draws or the rules draws again under the re-draw rules (in one transaction: a refusal leaves the rules as they were); once its day has come only the reveal date changes; every change audited (`draw_created`, `draw_changed`, `reveal_set`, `draw_removed`; who, which draw, when; never pairs) |
| `POST /api/celebrations/{id}/draw/run` (M3) | the host | needs the sealing key (409 without: no draw is made); pairs from `@keepsake/draw` with node:crypto (every valid assignment equally likely: nobody themselves, no excluded pair either way, optionally not last year's person; the search bounded to 300 ms); at least 4 people, and rules that cannot be drawn or let someone work out another's person are a 409 naming the rule, never a pair, decided without last year's pairs; re-draw freely until someone opened theirs, then only before the day and never once a participant has marked a gift bought for another since the draw (the host's own wishes left out, so the answer never depends on gifts meant for them), and everyone opens theirs again (`redrawnAt`); 20 tries a day per celebration and year; audited (`drawn`, `redrawn`, `draw_refused`) |
| `POST /api/celebrations/{id}/draw/open` (M3) | a participant | only their own row; 403 for anyone not in the draw; 409 before the names are drawn or before the draw-together time; records only that they opened (counted, never shown per person); hiding it again is the browser's |

**The sign-in limits**: 20 sign-in steps a minute per client and 300 for everyone together; the 300 count only the
steps a client's own limit let through, so one address cannot use up anyone else's budget. A client is the socket's
address (IPv6 by its /64, so one host cannot spread its tries over its own addresses); behind a proxy (HomersLab's edge, or a standalone https proxy named in `KEEPSAKE_TRUSTED_PROXY`, used then for
this and nothing else) it is the last `X-Forwarded-For` address that proxy set. Each client holds at most 20 waiting
challenges, and a full store drops the oldest of whoever holds the most, so one client cannot push out another's
sign-in in progress. Without a proxy, people behind one NAT share a limit; the global 300 bounds the load.

**The sealing key** (M3, ADR 0004): `KEEPSAKE_SEALING_KEY_FILE` (recommended: a value in `KEEPSAKE_SEALING_KEY` shows in
`docker inspect`; HomersLab gives it as a secret file) or `KEEPSAKE_SEALING_KEY` (base64, 32 bytes); standalone makes
`KEEPSAKE_KEYS_DIR/sealing.key` (default `./keys`, `/keys` in the image) once at start, `O_EXCL`, 0600, the folder 0700
(the smoke test checks both). A key file inside the data folder is refused at start, by real path and by device and
inode, so a symlink or bind mount of `data/` does not get past it; a key file others can read is warned about at start.
Without a usable key Keepsake still starts, but no draw is made or opened (409). The key's value is never logged, never
in an answer or error, and `JSON.stringify` of the configuration hides it. Rows carry their key's id: a previous key
(`KEEPSAKE_SEALING_KEY_PREVIOUS` or `_FILE`) still opens them, and `keepsake rotate-key` seals them all again with the
current one. A row that opens with no key here costs only its own giver their person (`mine.unreadable`); losing the
key loses the sealed draws (the host draws again). Keep a copy apart from the data's backups. GCM tags are pinned to 16
bytes and every row's length is checked.

**The data folder**: Keepsake runs with umask 077 and sets the folder to 0700 and `keepsake.sqlite`, `-wal`, `-shm` to
0600 at start (the smoke test checks it on a folder made 0755), so no other account on the host reads the household's
wishes. Make it with `mkdir -m 700 data`.

**People's devices** (standalone): your passkeys are listed and removable (the sessions a removed one signed in end;
the last one stays); "Sign out everywhere" ends all your sessions; a kid's parent or an admin ends someone's sessions
after a lost device; someone who lost every device gets their passkeys reset by an admin who has just signed in,
then a new invite. An admin who stops being one, or recovers with `keepsake recover`, loses their unused invites.

Every `/api` route but `/health` needs a person (deny by default); every change (anything but GET/HEAD/OPTIONS)
must carry `KEEPSAKE_ORIGIN` as its Origin, public sign-in steps included.

**The view seam** (ADR 0003). Route files get a narrow router (`apps/server/src/router.ts`), never the Fastify
instance, request or reply: a handler gets the path parameters, query and body and returns a view answer (or nothing,
a 204). The viewer is always the request's (`data.view(req)`); each view helper takes ids and builds its own answer.
`apps/server/src/seam.ts` then checks, in `onSend`, the last hook before the bytes leave: an answer below 400 with a
body must be byte for byte what the seam itself serialized from a view answer built for this very request (a string, a
Buffer, a stream, a copy, a changed object or an answer built for another request, say a cached one, is a 500); a 3xx
is a 500; an answer of 400 and above is `{ error }` with a message from the fixed catalogue
(`apps/server/src/errors.ts`); only known header names leave, and no cookie but `keepsake_session`. At start-up it
refuses any `/api` route the router did not make and any route-level hook, serializer or error handler, and puts its
own recording and guard on each route, so they run after every hook a scope adds. Admin-only operations check the role
in the data facade as well as in the route. Wishes carry no stored position: a list's order is its array's order, so no
number or gap counts the wishes hidden from the viewer. This guards against mistakes in our own
code, not deliberately hostile code in the server; the source bans in `test/architecture.test.ts` (no Fastify, raw
request, socket, reply, hooks or hand-made bytes in a route file; nothing reaches a raw stream anywhere) are the
backstop, and rogue routes run behind the seam there.

## Identity (M1)

- `homerslab` mode refuses to start without `KEEPSAKE_ORIGIN`, `KEEPSAKE_TRUSTED_PROXY` and
  `KEEPSAKE_EDGE_IDENTITY=homerslab-v1` (`apps/server/src/config.ts`; the smoke test starts it without them).
  `KEEPSAKE_TRUSTED_PROXY` must be one IP address (no host name, range or port; refused at start); IPv4-mapped and
  IPv6 addresses are compared in one canonical spelling on both sides.
- `X-HomersLab-*` count only when `req.socket.remoteAddress` (with `::ffff:` normalised) is the configured proxy;
  `trustProxy: false`, never `req.ip` or `X-Forwarded-*`. From any other source every `X-HomersLab-*` header is
  deleted in the first hook. A repeated person header, or a role other than exactly `admin`, `adult` or `kid`, is
  refused (403 for a missing or wrong role). A session cookie means nothing under HomersLab; a HomersLab header means
  nothing standalone.
- The smoke test's stand-in `KEEPSAKE_TRUSTED_PROXY=127.0.0.1` is not the source address behind `-p`, so it probes
  that a forged identity through `-p` gets 401, and public routes only otherwise.
- The logger redacts `authorization`, `cookie`, `x-homerslab-person`, `x-homerslab-name` and `x-homerslab-role`.
- Kids sign in (their own passkey standalone, their role under HomersLab). Who manages a kid is Keepsake's own in both
  modes until HomersLab's household API gives it. Under HomersLab a person exists in Keepsake only after their first
  visit, so a kid's parents can be set once the kid has opened Keepsake (issue #1).
