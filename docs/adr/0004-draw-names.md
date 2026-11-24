# ADR 0004: Draw names

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (draws belong to celebrations; reveal; draw together; guests)

**Decision**: A draw belongs to one celebration and is made by the server with a cryptographic random source. Until
the celebration's reveal date each giver can learn only their own receiver; nobody, the host and admins included, can
list the whole draw through the app. The host chooses a reveal date or never ("never" by default).

- **Rules**: nobody draws themselves; excluded pairs never draw each other (both ways); optionally nobody draws last
  year's person. Exclusions are seen by the host only. An impossible set of rules is refused before drawing, with which
  rule blocks it (not who drew whom).
- **Who draws**: the celebration's people, kids only if the host turns "Kids draw too" on, guests who joined with a
  personal draw link (ADR 0009).
- **Draw together**: optionally a time before which nobody can open their draw, so everyone opens at once.
- **Storage**: assignments sealed per giver (AES-256-GCM, key outside the database as in Philobiblos); the server opens
  only the signed-in giver's row, or every row after the reveal date when the host chose one. A database copy or backup
  alone reveals nothing.
- **Re-draw**: the host can re-draw before anyone opens their draw; after that, only before the celebration and with
  every participant told (their person changes); not after anyone has marked a gift bought.
- **Audit**: who created, drew, re-drew or revealed a draw and when; never the pairs.
