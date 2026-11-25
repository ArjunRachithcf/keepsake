# ADR 0007: Wishes first, celebrations as the logic

Status: **Proposed** · 2026-11-25 · revised 2026-11-25 (past one-off celebrations)

**Context**: v0.1 had one list per person with the occasion as a note. The design rounds (2026-11-24) put wishes
first and celebrations behind them: a celebration is not the main screen, but a wish can belong to one.

**Decision**: A wish belongs to its person and is **for one celebration or for any time**. There are no list objects:
a person's list for a celebration is computed: their wishes for it plus their any-time wishes. A wish given once is
gone everywhere (for everyone but its person until the celebration is over, ADR 0003).

- Celebrations are household objects with a date, place, poster and people; birthdays and Christmas recur yearly (a
  wish for "My birthday" follows to next year's if not given).
- Once a **one-off** celebration's day has passed (in the household's time zone), its wishes that were not given are
  for **any time** (decided 2026-11-25, PR #8 review): they stay on the person's list instead of dropping out of every
  chip. A yearly one rolls on to its next date and keeps its wishes.
- Someone taken out of a celebration, or a removed celebration, leaves their wishes for it as any-time wishes.
- Filtering by celebration (the chips) is a view over wishes, computed after the surprise filter.
- Moving a wish to another celebration or to "any time" keeps its claims.
- **Consequences**: no "list" table to keep in sync; share links point at a person (all their wishes) or at a draw
  (that celebration's list of the drawn person).
