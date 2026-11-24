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
