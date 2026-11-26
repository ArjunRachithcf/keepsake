# ADR 0004: Draw names

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (draws belong to celebrations; reveal; draw together; guests; M3's details)

**Decision**: A draw belongs to one celebration and is made by the server with a cryptographic random source. Until
the celebration's reveal date each giver can learn only their own receiver; nobody, the host and admins included, can
list the whole draw through the app. The host chooses a reveal date or never ("never" by default) before drawing;
once the names are drawn, "never" is never (no reveal date can be set any more) and a reveal date only moves later or
to never (Gate surprise L1: otherwise a host who drew with never could set today's date after the day and read every
pair, and the veils would lift).

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

**M3, decided by default (2026-11-25, revised after the PR #10 review; open to change)**:

- **One draw per celebration and year.** "Last year's person" means the same celebration's draw from the year before.
- **The draw's day** is the celebration's day that year. It is stored when the names are drawn (`occasion_on`) and
  only ever moves later: the day used is the later of the stored one and the celebration's day now. While the names
  are drawn and the day has not come, a change that would move the celebration earlier is refused (409). A move is
  audited (`draw_moved`).
- **Who draws** is a list the host picks from the celebration's people. Kids are in it only with "Kids draw too".
  - At least 4 people (with 3, whoever opens theirs knows the whole draw), at most 100; with "not last year's person"
    on, at least 5 (second review H4: with 4, whoever knows last year's pairs works out this year's from their own),
    decided from the settings alone.
  - A celebration whose host has left, or whose host has become a kid, has its draw run by an admin.
  - Someone in a drawn draw who becomes a kid stays in it until its day: "Kids draw too" decides who joins a draw, not
    who leaves one already drawn.
  - While a celebration's latest draw is drawn and its day has not come, no other draw is made for it (a one-off moved
    into the next year keeps its draw).
- **Rules that may be drawn** are decided from the participants and the exclusions only, never from last year's pairs:
  - some assignment keeps the exclusions (nobody draws themselves, no excluded pair either way);
  - nobody can work out anyone else's person: not the host from the rules, and not a giver from the rules plus their
    own person. Up to 16 people this is exact: for every pair a giver could have, every other giver keeps at least two
    possible people (pairs that occur in some perfect matching, found by alternating cycles). Above 16 a sufficient
    rule applies: everyone keeps at least ⌈n/2⌉+1 people they may draw;
  - with "not last year's person" on, everyone keeps at least ⌈n/2⌉+1 people they may draw after the exclusions.
    Taking away last year's pairs then costs each giver and each receiver at most one, which leaves every degree at
    least n/2, so a perfect matching always exists (Hall). Last year's pairs therefore never block or shape a refusal,
    and nothing about them can be learned by trying exclusions. The cost: 4 or 5 people allow no exclusion with this
    rule on; from 6, one partner each fits.

  A refusal names the rule ("too few", "who shouldn't draw whom", "with not last year's person on, everyone needs more
  people they may draw", "these rules let someone work out another's person"), never a pair.
- **Uniform**: every valid assignment is equally likely. Up to 16 people the draw counts exactly; above 16 it uses
  rejection sampling within 300 ms, and if that finds nothing it refuses with "the rules leave too few ways to draw in
  time: loosen who shouldn't draw whom". From about 20 people, rules right at the ⌈n/2⌉+1 margin always end there;
  real exclusions (couples) are far from it.
  Above 16, whether that last refusal happens can depend slightly on last year's pairs; this is accepted in
  docs/security.md. Random numbers come from node:crypto, as 48-bit values from a pool, with rejection to keep them
  uniform.
- **Tries**: at most 20 a day per celebration and year, counted in `draw_try`, so removing and re-making a draw does
  not reset the count.
- **Sealing**: one AES-256-GCM row per giver.
  - The draw and the giver are bound in as associated data, so a row moved to another giver does not open.
  - The plaintext is padded to one length, the tag is pinned at 16 bytes and the row length is checked.
  - Rows are written in the givers' order.
- **The key**:
  - `KEEPSAKE_SEALING_KEY` or `_FILE`. Standalone makes `keys/sealing.key` once, the folder 0700.
  - A key inside the data folder is refused. The check compares real paths and device and inode, so neither a symlink
    nor a bind mount gets a key in.
  - A previous key (`KEEPSAKE_SEALING_KEY_PREVIOUS` or `_FILE`) still opens the rows it sealed, chosen by the row's
    key id. `keepsake rotate-key` seals every row again with the current key.
  - A row that opens with no key here is a problem for its own giver only (`mine.unreadable`); the draw still answers.
  - Without a key, nothing is drawn or opened.
- **The reveal**:
  - It is a day after the celebration, or never.
  - Once it has happened it is latched (`revealed_at`): the host cannot take it back (409) and a later day does not
    hide it again.
  - The pairs go to the participants and the host.
- **Gifts between the people of a draw** (ADR 0003, review H1): while a draw is drawn and not revealed, a claim, a
  share or a group gift started by one of its people for another, made up to its day (the household's day the gift
  was made, in its time zone), names no giver to anyone but the giver. The counts stay, so nobody buys twice. This
  depends on who is in which draw, never on who drew whom.
- **Veils** (second review M3, L6): when a drawn, unrevealed draw goes (its celebration removed, the draw removed),
  or its people or rules change once drawn, or someone leaves it, a veil keeps who was in it and its day (never its
  pairs). Gifts they made each other up to that day stay unnamed, as above. While its draw lives on, a veil follows it:
  lifted only once the draw itself is revealed (never with "never"), its day the draw's day now (third review L8). When
  the draw goes, its veils take its day and reveal date as they are then (a revealed draw's veils go), and from then on
  lift on that reveal date if there was one and it has passed after the day; with "never", for good. So removing a
  celebration after its day is allowed and gives nothing away.
- **Kids draw too** is checked against the roles when the names are first drawn too: someone who became a kid before
  then is refused without it; someone who becomes a kid after stays.
- **Re-draw**:
  - Free until someone has opened theirs. After that, only before the day, and not once a participant has marked a
    gift bought for another since the names were drawn. The caller's own wishes are left out of that check.
  - Changing who draws or the rules once drawn is a re-draw.
  - "Everyone told" is in the app (`redrawnAt`: everyone opens theirs again) and, since M5, as a notice to each person
    in the draw but whoever drew, with its push that names nobody (ADR 0010).
  - Once the day has come, only the reveal date changes (later, or to never; never once drawn with never).
- **Someone in a drawn draw leaves the household**:
  - Before its day, under the re-draw rules: they are taken out and the others are drawn again, everyone told if
    anyone had opened theirs. If the others can no longer be drawn (too few, say), the draw goes back to not drawn,
    also told (`draw_cleared`).
  - If the re-draw rules forbid it (someone opened theirs and a gift has been bought since), the removal is refused
    until the day.
  - After the day, their rows go. Whoever drew them keeps nobody ("They have left"), and nobody is drawn for again.
- **A celebration with a drawn draw** can be removed before its day only under the re-draw rules. After its day it can
  be removed: its draws leave veils.
- **Opening** is recorded (for "4 of 6 opened") but never shown per person. Hiding it again is the browser's.
- **Guests** (M4) join as participants of kind `guest`; the tables already have the kind.
- **A host who is in the draw holds the cousin's link** (PR #11's second review, N2): its address is shown to the
  host once, and whoever opens it sees whom the cousin drew. Known and accepted, with the link opening on one device
  only (ADR 0009): if the host opens it, the cousin is told it was opened on another device, and the host is warned
  not to when it is made.
- **The host can give the cousin's link a new address** (PR #11's fourth review, R-1), and open it: known and accepted,
  because it shows. Her session ends at once, the new address's page tells her when the earlier one was last used, and
  the host's list counts the new addresses. Only whoever runs the draw can (its host, an admin only when it has none):
  an admin in the draw who is not its host cannot, so the pairs stay secret from everyone else in it.
- **An admin does not become someone to open their draw** (Gate routes M1, decided by Arjun 2026-11-26; re-attack B1,
  the same day). A passkey reset followed by an invite let an admin enrol as anyone and open their draw (demoting an
  admin first got round "never an admin's"); then a lone admin made a "second admin", enrolled them from their own
  invite and had the yes at once. Now a reset needs a second admin's yes or a day; the yes counts only from someone who
  was an admin, with a passkey of their own, a week before the ask, none of whose passkeys came from the asker's invite,
  and it is carried out an hour after the yes at the earliest. An ask whose asker has gone is nobody's. At the ask,
  before anything is reset, the person is warned (a notice and a push to their devices, their sessions kept, so they
  can call it off), and the other admins, the people of their open draws and a kid's parents are told; done, all of
  them again ("X's sign-in was reset by Y"). The reset person's draws stay sealed to them (no receiver, no pairs, no
  opening, and nothing of their own for the people of those draws is marked theirs: claims, shares, ideas, questions,
  gifts given and their thank-yous, Gate re-attack R2) until they confirm on their new device; someone demoted from
  admin in the last 30 days is still an admin for resets; new people, role changes, invites and every step of a reset
  are audited. Accepted: two genuine, long-standing admins acting together, or one admin when the person ignores a day
  of warnings, can still do it, loudly (docs/security.md).
