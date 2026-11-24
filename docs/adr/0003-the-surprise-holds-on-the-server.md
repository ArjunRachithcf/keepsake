# ADR 0003: The surprise holds on the server

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (group gifts, questions, guests)

**Decision**: No response Keepsake sends to a person ever contains, for a wish meant for them: a claim, a share of a
group gift, a "bought" or "given" mark, or an idea kept for them; nor who asked them a question (ADR 0008), nor an
assignment of a draw other than the one where they give (ADR 0004).

- **One view layer.** Every route that returns wishes, claims, group gifts, ideas, questions or draws builds its
  answer with `viewFor(viewer)`; routes never serialize database rows themselves (an architecture test keeps it so).
- **"Meant for them"**: the wish's person; for a kid's wish, the kid too. Managers of a kid see its claims (they
  coordinate), unless they are the one it's for. A guest is a viewer like any giver, never "meant for".
- **Before filtering and sorting**: claims and shares are removed before any filter, count, sort, celebration list or
  "fully claimed"/"gone" flag is computed, so neither a filter, the order, a count nor an empty slot gives one away.
  "Given once, gone everywhere" is applied to everyone **except** the person, who keeps seeing the wish until the
  celebration is over.
- **No live stream of claims to the person**: updates to a person carry their own wishes only.
- **After the celebration**: a giver who chose to put their name on a gift is shown to the person (thank-yous); the
  others stay hidden for good.
- **Tests**: for every route, a matrix of viewer × wish (person, manager, other adult, kid, share-link guest,
  draw-link guest) asserts on the raw response bytes that the claimer's id and name, the share amounts and the asker
  are absent where they must be (the Wishlist lesson: test the data, not the screen).
