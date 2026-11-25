# ADR 0009: Guests by link

Status: **Proposed** · 2026-11-25

**Decision**: People outside the household never get an account. They get a link, of two kinds:

- **Share link**: made for someone's wishes by **another grown-up of the household** (for a kid, one of the kid's
  parents), **never by the person**: the page shows what is taken. The guest views and claims with a name they type;
  claims follow ADR 0003 (never shown to the person).
- **Personal draw link**: made by a celebration's host for one named guest (a cousin). The guest joins that
  celebration's draw (ADR 0004), opens their own person, sees that person's list for the celebration, can claim and
  ask. The link expires when the celebration is over (end of its day, household time).

Both: 256-bit random tokens in the URL fragment (never sent in a request line or logged), hashed at rest, revocable,
rate limited, read-only except claims, questions and the guest's own name; no route beyond the one person or draw.

**M4, decided by default (2026-11-25, open to change)**:

- **The link is the guest**: one row per link (`guest_link`), so its maker makes one share link per guest (a label
  says who for, at most 20 open per person), and a draw link is one named cousin.
- **The session**: the page reads the token from the fragment and POSTs it (`/guest/session`, rate limited as a
  sign-in) for `keepsake_guest`, HttpOnly, Secure, SameSite=Strict, on one device (see the second review below).
- **What a guest sees**: the listed wishes of the one person (share link) or, once they opened their draw, their own
  person's list for the celebration; as a giver, but **with nobody's name on a gift** (counts and their own only): a
  forwarded link should not tell an outsider who in the family gives what. That person's sizes, likes and "please
  no", read-only (a godmother buying clothes needs them; a draw guest only their own person's, once opened). No
  ideas, household or other people. Guests claim (and mark bought, given, back) but do not chip into group gifts.
- **What the household sees**: a guest's claim, marked as a guest's, with the name the guest gave and the link's label
  ("Ada (guest: Godmother)"), except while a draw keeps its people's gifts unnamed (guests count as its people).
  Claims wait until the guest has given a name; a guest's name is never a household member's (case and accents aside)
  and carries no control or bidi characters (review M2). Since the second review (L-b): no format character at all
  (Cf: zero-width spaces and joiners, the word joiner, the soft hyphen too) nor a Hangul filler, and names compare
  without the characters that show nothing (Default_Ignorable_Code_Point). The other way round, a new member or a new
  name like a guest's that the admin sees (the guests of links they manage) is refused until they confirm it.
- **Draw links**: inviting a guest after the names are drawn is a re-draw under the re-draw rules; the draw's rules
  count the guests. The link ends with the draw's day (household time). Revoking a guest before the draw takes them
  out; once drawn they stay in it and only the link stops. Removing the draw revokes its links.
- **A guest's claims once they cannot manage them** (review M1): when their link is revoked, a re-draw gives a draw
  guest someone else, the wish moves to another celebration than a draw guest's (second review, L-a), or their
  celebration or draw goes, their claims only made go (the wish is free again) and bought
  or given ones stay with nobody's name, as when a giver leaves (ADR 0003). The changing request does it, never a
  person's reading one.
- **Under HomersLab** no guest link is made (409, and the screens say so) until HomersLab's edge lets guests through
  to `guest_paths` (Homeward #317).

**Review of PR #11, decided 2026-11-25 (H1)**: the person, and kids, never hold a working link to their own wishes.

- **Who makes a share link**: another grown-up; for a kid, a parent. Never the person, never a kid. (This replaces "a
  kid's own link waits for a parent's yes": there is no such link.)
- **Who sees its address**: its maker, once, at creation. No route returns a token again; to see one again, make a new
  link (and revoke the old). The screen says not to open it oneself, and never to send it to its person.
- **Who lists it**: its maker and admins (label, made, opened, revoked; never the address), never the person it shares,
  an admin included, and never kids. A kid's share link: the kid's current parents and admins, so its links go with
  the kid when an admin changes the kid's parents (second review, L-c). A draw link: the celebration's host and admins.
- **Defence in depth**: the exchange answers its one failure when the browser carries a household session the link is
  not for: a share link's person or a kid; for a draw link, anyone in that draw (its pairs, and the gifts between its
  people, stay secret from them). Questions' per-person limit counts only delivered questions, which everyone giving
  sees anyway, so its refusal says nothing about questions on their way.
- **Known and accepted**: someone of the household who is sent a link to their own wishes and opens it in a browser
  without their household session (another browser, their phone; under HomersLab, once guests are let in) sees what
  is taken. Keepsake cannot tell them from the guest it was meant for; the rules above make it take someone else's
  deliberate act.

**Second review of PR #11, decided 2026-11-25**:

- **A guest session left in a shared browser** (N1): on every guest route, a household session along with the guest's
  counts only to refuse. When it is one the link is not for (the same rule as the exchange: a share link's person or a
  kid; for a draw link anyone in that draw), the guest session ends and the answer is the one 401 of an unknown
  session; every refusal there clears the guest cookie. So the person who signs in later on the family computer never
  sees the page a guest left open there.
- **A link opens on one device** (N2): the first exchange spends the token (`opened_at`, set in the same statement
  that checks it is unset) and its session lasts as long as the link (a share link until revoked, a draw link until
  its day; at most 400 days, a browser's limit for a cookie). The browser that holds the session may follow the link
  again; any other exchange answers "this link was opened on another device" (409, after every check the one 401
  answers, so the person and kids still get only the 401). Its maker (and whoever lists it) sees "opened" with the
  day; the opening is audited (`link_opened`, its actor the household member whose browser it was, else the link).
  "Forget this link on this device" ends it for good, and the page says so first.
- **Why**: a draw link's address is shown to the host, who is usually in the draw, and whoever opens it sees whom the
  cousin drew and what is taken (for them too, if the cousin drew the host). The address cannot avoid its maker, so
  opening it can no longer go unnoticed: a host who opens it locks the cousin out, and the cousin is told. The same
  holds for anyone a share link reaches by mistake. When a link is made, its maker is told not to open it, not even to
  try it, and for a draw link that someone in the draw would see their own gifts.
- **Known and accepted**: a host in the draw (or anyone sent a link to their own wishes) who opens it before its guest
  does sees what it shows; Keepsake cannot tell them from the guest. The guest then finds the link opened elsewhere and
  asks for a new one, and the maker's list shows when it was opened. A lost device means a new link.

**Third review of PR #11, decided 2026-11-25**:

- **The device, not the cookie, is what opens** (M-a): `keepsake_guest` is one random device cookie (400 days, SHA-256
  at rest) that holds the sessions of every link the browser opened. The first exchange records it on the link
  (`opened_by`); a session is found by link and device, and each guest request names its link (`X-Keepsake-Link`,
  the link's id, which the guest page keeps in its address after the exchange). So the godmother with links to two
  people's wishes goes back and forth in one browser; another device still gets the 409. A first exchange ends any
  session the link had (none should remain), and a household sign-in ends the device's sessions.
- **Idle sessions** (L-2): a guest session ends after 30 days without use, on top of the link's own end (and the 400
  days); a household sign-in in the browser clears `keepsake_guest` and ends its sessions.
- **Forget this link on this device** ends its session and leaves no device holding the link: it opens nowhere any more.
