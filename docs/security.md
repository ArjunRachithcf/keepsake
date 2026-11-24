# Security: threat model (draft)

Keepsake holds a household's wishes, who is giving what to whom, and its kids' lists. Its one promise beyond keeping
that private is the surprise: the person a gift is for must not learn it from Keepsake (ADR 0003, 0004).

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Wishes, prices, notes, kids' lists | SQLite | private to the household; kids especially |
| Claims and "bought" marks | SQLite | the surprise: never to the person a wish is for |
| Ideas kept for someone | SQLite | the surprise |
| Exchange assignments | sealed per giver; key outside the database | nobody may list the whole draw |
| Sessions, invite links | hashed in SQLite | sign-in |

## Actors and what stops them

| Actor | Could try | Controls |
|---|---|---|
| **The person a gift is for** | read claims or ideas on their own list: page data, API, live updates, filters, sort order, counts, error messages, export | ADR 0003: one view layer, claims removed before any filter/sort/count, no claim stream to owners; a viewer × list matrix of raw-response tests |
| **A curious adult or admin** | list the whole draw | ADR 0004: sealed per giver, no route lists pairs, audit without pairs |
| **A kid** | see their own claims; make their list public | kids are "meant for" on their list; public only with an adult's approval |
| **A stranger on the LAN / internet** | reach the app, forge identity headers, take over an empty install | identity headers only from the configured proxy and only once the edge strips them; standalone binds 127.0.0.1; no first-visitor admin: the first admin comes from HomersLab's roles or a one-time setup link in the data folder (Philobiblos ADR 0010) |
| **Another website** | CSRF | SameSite=Strict; Origin required on every change; `frame-ancestors 'none'` |
| **A hostile shop page** (add from a link, Q6) | SSRF, huge or scripted pages, decoder exploits | only if Q6 is accepted: Philobiblos' egress client and media worker, or nothing fetched at all |
| **Someone with a backup** | read the draw | sealed with a key that is not in the database or its backup |

## Rules

Each new route, job or import states its actor and control here before it merges (ADR 0006).
