# ADR 0011: Add a wish from a shop link, through one hardened egress

Status: **Proposed** · 2026-11-25 (M5, decided by default, open to change)

**Context**: spec §8 (2026-11-24): "Add from a link: later (M5), only through a hardened egress; typed wishes first".
Until M5 the server opened no connection at all (an architecture test said so). A shop page is hostile input, and a
fetch of an address someone typed is the classic server-side request forgery: the router, the HomersLab edge, a
neighbour container, the cloud metadata address.

**Decision**: Philobiblos' egress pattern (its ADR 0009, `src/net/egress.ts`), ported, and nothing else.

- **One HTTP client** (`apps/server/src/net/egress.ts`) for the whole server; the architecture test allows `http`,
  `https`, `dns` and the like in that file only, no `fetch`, no HTTP library, and only the push queue (ADR 0010) and
  this feature use it.
- **Only the shops the household lists**: `KEEPSAKE_SHOP_HOSTS`, exact host names, from the environment only (a
  security setting never lives in the database, spec §10). Empty by default: then the feature is off, the screens do
  not offer it, and no page is ever fetched. `KEEPSAKE_EGRESS=off` turns all egress off (no push either).
- **https on 443 only**, no credentials, never an IP address; the name resolved by the client and the connection made
  to the address that was checked (no second lookup for DNS rebinding); every address the name resolves to must be
  public (IANA's special-purpose ranges refused, IPv6 global unicast only, v4-mapped addresses as their v4).
- **Redirects**: at most 3, each to a listed shop (so `shop.ch` → `www.shop.ch` works when both are listed), https,
  checked and resolved again.
- **Limits**: no compression, `text/html` only, 1 MB counted as it arrives, 10 s for the whole exchange (the lookups and
  redirects included), an honest User-Agent (`Keepsake/<version>`), no cookies, no Referer.
- **Read as text**, by plain scanning (no regular expression runs over the page, at most 2000 tags of a kind, a tag of
  at most 3000 characters, a JSON-LD block of at most 100 KB): no DOM, no script, no style, nothing the page names is fetched (no pictures, so no image decoder and
  no media worker are needed). A few fields only: the product's name and price from its JSON-LD (schema.org
  `Product`) or its Open Graph and product meta tags, else its `<title>`; entities decoded, control and format
  characters dropped, the name cut to 120 characters, the price kept only in the household's currency (otherwise it is
  shown as the page states it).
- **Nothing is stored**: `POST /api/link-preview` answers a proposal the person reads and changes; they save it as any
  typed wish (`POST /api/wishes`), with the link they pasted. A wish's link is still never fetched by itself.
- **Every failure** is one of two fixed refusals ("Keepsake reads pages only from the shops on its list", "the page
  could not be read"): never the page's own words.
- **Who**: someone of the household (never a guest); 30 pages an hour and one at a time per person, 4 at once in all.

**Consequences**: the server now has one way out, for two purposes. The HomersLab manifest names its egress: the push
services and the household's shops. Accepted: the shop learns the household's address and that someone looked at the
item; a listed shop's page can still say anything about itself, which the person sees before saving.
