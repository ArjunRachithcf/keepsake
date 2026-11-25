# ADR 0004: Draw names

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (draws belong to celebrations; reveal; draw together; guests; M3's details)

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

**M3, decided by default (2026-11-25, open to change)**:

- **One draw per celebration and year**, for the celebration's day that year, read from the celebration when needed, so
  a postponed day moves it. "Last year's person" is the same celebration's draw of the year before.
- **Who draws** is a list the host picks from the celebration's people (kids only with "Kids draw too"); at least 3
  (with 2, each knows who drew them), at most 100. Someone in a drawn draw stays in the celebration until the draw
  changes; before it is drawn they simply leave it. A celebration whose host has left: an admin runs its draw.
- **Uniform**: `@keepsake/draw` makes every valid assignment equally likely (exact counting up to 16 people, rejection
  sampling above), with node:crypto's `randomInt`. Impossible rules are refused naming the rule: too few, who shouldn't
  draw whom, not last year's person (blamed when the exclusions alone would allow a draw), or rules too tight for the
  random tries above 16 people.
- **Sealing**: one AES-256-GCM row per giver, the draw and the giver as associated data (a row moved to another giver
  does not open), the plaintext padded to one length, the rows written in the givers' order. The key:
  `KEEPSAKE_SEALING_KEY` or `_FILE`; standalone makes `keys/sealing.key` once (never inside the data folder). Without it
  nothing is drawn or opened. The server opens every row only after the reveal, or inside a draw for last year's pairs.
- **The reveal** is a day after the celebration or never; computed when read, so a later celebration day delays it.
  The pairs go to the participants and the host.
- **Re-draw**: freely until someone opened theirs; after that, before the day only, and not once a participant has marked
  a gift bought for another since the names were drawn. The host's own wishes are left out of that check: whether
  someone bought them something is not theirs to learn (ADR 0003). Changing who draws or the rules once drawn is a
  re-draw. "Everyone told" is in the app for M3 (`redrawnAt`: everyone opens theirs again); the push that says so comes
  with M5 and names nobody. Once the day has come only the reveal date changes.
- **Opening** is recorded (for "4 of 6 opened") but never shown per person; hiding it again is the browser's.
- **A known limit**: with "not last year's person" on, whether a draw is possible depends on last year's pairs, so a host
  who tries exclusions could learn something of them. Refused tries are audited and every try counts against 20 a day
  per draw (docs/security.md).
- **Guests** (M4) join as participants of kind `guest`; the tables already have the kind.
