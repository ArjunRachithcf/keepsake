# ADR 0009: Guests by link

Status: **Proposed** · 2026-11-25

**Decision**: People outside the household never get an account. They get a link, of two kinds:

- **Share link**: made by a person (or a kid's parent) for their own wishes. The guest views and claims with a name
  they type; claims follow ADR 0003 (never shown to the person). A kid's wishes only with a parent's approval.
- **Personal draw link**: made by a celebration's host for one named guest (a cousin). The guest joins that
  celebration's draw (ADR 0004), opens their own person, sees that person's list for the celebration, can claim and
  ask. The link expires when the celebration is over (end of its day, household time).

Both: 256-bit random tokens in the URL fragment (never sent in a request line or logged), hashed at rest, revocable,
rate limited, read-only except claims, questions and the guest's own name; no route beyond the one person or draw.

**M4, decided by default (2026-11-25, open to change)**:

- **The link is the guest**: one row per link (`guest_link`), so the person makes one share link per guest (a label
  says who for, at most 20 open), and a draw link is one named cousin.
- **The session**: the page reads the token from the fragment and POSTs it (`/guest/session`, rate limited as a
  sign-in) for `keepsake_guest`, HttpOnly, Secure, SameSite=Strict, 12 hours; the guest opens the link again after.
- **What a guest sees**: the listed wishes of the one person (share link) or, once they opened their draw, their own
  person's list for the celebration; as a giver, but **with nobody's name on a gift** (counts and their own only): a
  forwarded link should not tell an outsider who in the family gives what. No profile, ideas, household or other
  people. Guests claim (and mark bought, given, back) but do not chip into group gifts.
- **What the household sees**: a guest's claim with the name the guest gave, except while a draw keeps its people's
  gifts unnamed (guests count as its people). Claims wait until the guest has given a name.
- **Draw links**: inviting a guest after the names are drawn is a re-draw under the re-draw rules; the draw's rules
  count the guests. The link ends with the draw's day (household time). Revoking a guest before the draw takes them
  out; once drawn they stay in it and only the link stops. Removing the draw revokes its links.
- **A kid's own share link** opens nothing until a parent says yes; a parent's link for the kid works at once.
