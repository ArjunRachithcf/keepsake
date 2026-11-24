# ADR 0003: The surprise holds on the server

Status: **Proposed** · 2026-11-24

**Decision**: No response Keepsake sends to a person ever contains a claim on a wish meant for them, an idea kept for
them, or an assignment of an exchange other than the one where they give.

- **One view layer.** Every route that returns wishes, claims or exchanges builds its answer with `viewFor(viewer)`;
  routes never serialize database rows themselves (an architecture test keeps it so).
- **"Meant for them"**: the list's owner; for a kid's list, the kid too. Managers of a kid's list see its claims (they
  coordinate), unless they are the one it's for.
- **Before filtering and sorting**: claims are removed before any filter, count, sort or "fully claimed" flag is
  computed, so neither a filter nor the order nor an empty slot gives a claim away.
- **No live stream of claims to the owner**: updates to a list's owner carry wishes only.
- **Tests**: for every route, a matrix of viewer × list (owner, manager, other adult, kid, guest) asserts on the raw
  response bytes that the claimer's id and name are absent where they must be (the Wishlist lesson: test the data,
  not the screen).
