# ADR 0004: Draw names

Status: **Proposed** · 2026-11-24

**Decision**: An exchange's draw is made by the server with a cryptographic random source; each giver can learn only
their own receiver; nobody, admins included, can list the whole draw through the app.

- **Rules**: nobody draws themselves; excluded pairs never draw each other (both ways); optionally nobody draws last
  year's person. An impossible set of rules is refused before drawing, with which rule blocks it (not who drew whom).
- **Storage**: assignments sealed per giver (AES-256-GCM, key outside the database as in Philobiblos); the server opens
  only the signed-in giver's row. A database copy or backup alone reveals nothing.
- **Re-draw**: an admin can re-draw an exchange before its date (everyone's person changes, everyone is told); not
  after anyone has marked a gift bought, unless every participant agrees (open).
- **Audit**: who created, drew or re-drew an exchange and when; never the pairs.
