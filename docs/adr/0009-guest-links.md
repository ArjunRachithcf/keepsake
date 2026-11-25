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
  sign-in) for `keepsake_guest`, HttpOnly, Secure, SameSite=Strict, 12 hours; the guest opens the link again after.
- **What a guest sees**: the listed wishes of the one person (share link) or, once they opened their draw, their own
  person's list for the celebration; as a giver, but **with nobody's name on a gift** (counts and their own only): a
  forwarded link should not tell an outsider who in the family gives what. That person's sizes, likes and "please
  no", read-only (a godmother buying clothes needs them; a draw guest only their own person's, once opened). No
  ideas, household or other people. Guests claim (and mark bought, given, back) but do not chip into group gifts.
- **What the household sees**: a guest's claim, marked as a guest's, with the name the guest gave and the link's label
  ("Ada (guest: Godmother)"), except while a draw keeps its people's gifts unnamed (guests count as its people).
  Claims wait until the guest has given a name; a guest's name is never a household member's (case and accents aside)
  and carries no control or bidi characters (review M2).
- **Draw links**: inviting a guest after the names are drawn is a re-draw under the re-draw rules; the draw's rules
  count the guests. The link ends with the draw's day (household time). Revoking a guest before the draw takes them
  out; once drawn they stay in it and only the link stops. Removing the draw revokes its links.
- **A guest's claims once they cannot manage them** (review M1): when their link is revoked, a re-draw gives a draw
  guest someone else, or their celebration or draw goes, their claims only made go (the wish is free again) and bought
  or given ones stay with nobody's name, as when a giver leaves (ADR 0003). The changing request does it, never a
  person's reading one.
- **Under HomersLab** no guest link is made (409, and the screens say so) until HomersLab's edge lets guests through
  to `guest_paths` (Homeward #317).

**Review of PR #11, decided 2026-11-25 (H1)**: the person, and kids, never hold a working link to their own wishes.

- **Who makes a share link**: another grown-up; for a kid, a parent. Never the person, never a kid. (This replaces "a
  kid's own link waits for a parent's yes": there is no such link.)
- **Who sees its address**: its maker, once, at creation. No route returns a token again; to see one again, make a new
  link (and revoke the old). The screen says not to open it oneself, and never to send it to its person.
- **Who lists it**: its maker and admins (label, made, revoked; never the address), never the person it shares, an
  admin included, and never kids. A draw link: the celebration's host and admins.
- **Defence in depth**: the exchange answers its one failure when the browser carries a household session the link is
  not for: a share link's person or a kid; for a draw link, anyone in that draw (its pairs, and the gifts between its
  people, stay secret from them). Questions' per-person limit counts only delivered questions, which everyone giving
  sees anyway, so its refusal says nothing about questions on their way.
- **Known and accepted**: someone of the household who is sent a link to their own wishes and opens it in a browser
  without their household session (another browser, their phone; under HomersLab, once guests are let in) sees what
  is taken. Keepsake cannot tell them from the guest it was meant for; the rules above make it take someone else's
  deliberate act.
