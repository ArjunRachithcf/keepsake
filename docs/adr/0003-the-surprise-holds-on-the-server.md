# ADR 0003: The surprise holds on the server

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (group gifts, questions, guests; M2: kids, the occasion, givers' shares)

**Decision**: No response Keepsake sends to a person ever contains, for a wish meant for them: a claim, a share of a
group gift, a "bought" or "given" mark, or an idea kept for them; nor who asked them a question (ADR 0008), nor an
assignment of a draw other than the one where they give (ADR 0004).

- **One view layer.** Every route that returns wishes, claims, group gifts, ideas, questions or draws builds its
  answer with `viewFor(viewer)`; routes never serialize database rows themselves (an architecture test keeps it so).
  The viewer is always the request's (`data.view(req)`), and each view helper takes ids and builds its own answer: no
  route hands in a person, a row or a ready object.
- **The seam** (M1, `apps/server/src/seam.ts`, `router.ts`). Route files get a narrow router, never the Fastify
  instance, request or reply. Before an answer leaves, the seam compares the bytes about to be sent with what it
  serialized itself from a view answer, refuses redirects, error bodies outside a fixed catalogue and unknown headers,
  and at start-up refuses any route the router did not make and any route-level hook or serializer. **It guards
  against mistakes in our own code, not against deliberately hostile code in the server**: code that sets out to get
  around it can (the server is one process). The source bans in the architecture test (no Fastify, raw request,
  socket, reply or hand-made bytes in a route file) are the backstop, and review is the rest.
- **"Meant for them"**: the wish's person; for a kid's wish, the kid too. Managers of a kid see its claims (they
  coordinate), unless they are the one it's for. A guest is a viewer like any giver, never "meant for".
- **Kids see no gifts at all** (decided 2026-11-25, PR #8): not on anyone's wishes, so nothing spoils through a kid. A
  kid sees every list as its person does, and claims and chips in from M5 at the earliest, if ever.
- **Givers' shares**: other givers see who chipped in and the total, not each other's amounts.
- **Before filtering and sorting**: claims and shares are removed before any filter, count, sort, celebration list or
  "fully claimed"/"gone" flag is computed, so neither a filter, the order, a count nor an empty slot gives one away.
  "Given once, gone everywhere" is applied to everyone **except** the person, who keeps seeing the wish until the
  celebration is over.
- **No live stream of claims to the person**: updates to a person carry their own wishes only.
- **After the celebration**: a giver who chose to put their name on a gift is shown to the person (thank-yous); the
  others stay hidden for good. The name is off by default and can be put on only once the gift is given and its day
  is over. "The celebration" is the occasion the gift was claimed for (the wish's celebration, else the person's next
  one), kept with the claim: a claim more than a month past its day when it is marked given counts for the next one;
  with no celebration at all, the day after it was given.
- **The person's answers to gift routes** are a 403 decided from the wish and the caller alone, before any gift is
  read; nothing a giver does changes the wish's own row (its `updatedAt`, order, celebration).
- **Tests**: for every route, a matrix of viewer × wish (person, manager, other adult, kid, admin, share-link guest,
  draw-link guest) asserts on the raw response bytes that the claimer's id and name, the share amounts and the asker
  are absent where they must be (the Wishlist lesson: test the data, not the screen). M2's (`test/gifts.test.ts`)
  goes further for whoever may not see gifts: every reading answer must equal, byte for byte, the answer with no
  gifts at all, in every state before the celebration is over. Guests join the matrix with their links (M4).
