# ADR 0003: The surprise holds on the server

Status: **Proposed** · 2026-11-24 · revised 2026-11-25 (group gifts, questions, guests; M2: kids, the reveal (only later, latched), givers' shares, givers who leave)

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
- **Ideas and askers (M4)**: ideas for a person are read only for grown-ups other than the person; the asker of a
  question is compared with the caller only (`isAsker`) and never sent. Guests see gifts without any giver's name.
- **"Meant for them"**: the wish's person; for a kid's wish, the kid too. Managers of a kid see its claims (they
  coordinate), unless they are the one it's for. A guest is a viewer like any giver, never "meant for".
- **Kids see no gifts at all** (decided 2026-11-25, PR #8): not on anyone's wishes, so nothing spoils through a kid. A
  kid sees every list as its person does, and claims and chips in from M5 at the earliest, if ever.
- **Givers' shares**: other givers see who chipped in and whether it is enough, never each other's amounts nor the
  total (Gate surprise L3: with two sharers the total less your own share is the other's, and with more the total
  before and after gives each new share). Nothing refuses a share for what the others put in (only a share alone above
  the target), and the organizer may set any target, so no refusal can be used to find the total either. Accepted:
  "enough or not" with one other sharer bounds their amount (at least the target less yours, or less than it).
- **Givers in a draw** (M3, PR #10 review): while a draw is drawn and not revealed, a claim, share or group gift by one of
  its people for another (made up to its day) names no giver to anyone but the giver, so a gift never says who drew
  whom (ADR 0004). The counts stay.
- **Before filtering and sorting**: claims and shares are removed before any filter, count, sort, celebration list or
  "fully claimed"/"gone" flag is computed, so neither a filter, the order, a count nor an empty slot gives one away.
  "Given once, gone everywhere" is applied to everyone **except** the person, who keeps seeing the wish until the
  celebration is over.
- **No live stream of claims to the person**: updates to a person carry their own wishes only. Notices and pushes
  (M5, ADR 0010) are made only from what their person may know, and the byte matrices read them too.
- **After the celebration**: a giver who chose to put their name on a gift is shown to the person (thank-yous); the
  others stay hidden for good. A kid's thank-yous go to the kid and to the kid's parents (they help write them; decided
  2026-11-25, PR #9), also only once the occasion is over. The name is off by default and can be put on only once
  the gift has reached its person.
- **When a given gift reaches its person** (decided 2026-11-25, PR #9 reviews): the day after the **latest** of
  (a) the occasion's day kept when the gift was marked given, (b) the wish's current occasion, computed when read,
  and (c) the day it was given. So the reveal only ever moves **later**: a postponed celebration or a wish moved to a
  later one postpones it; moving the wish earlier, to any time, or removing its celebration never brings it forward.
  The occasion is the wish's celebration's day (a yearly one: the day the gift counts for, the one up to 30 days
  before it was given, so a late gift is still for it, else the next); for a wish that became any time when its
  one-off celebration passed (ADR 0007), that celebration's day if at most 30 days before the gift (a late gift for
  the party is revealed the next day); for any other any-time wish, the person's next celebration on or after the
  day it was given; with none, only (a) and (c). A late gift is revealed the next day, not the same day.
- **Once revealed, it stays revealed**: the first day its person has it is kept with the gift (`revealed_on`), so a
  date corrected later never hides it again, and the giver cannot mark it not given any more.
- **A giver who leaves** (removed from the household): a claim only made, and a share of a group gift not yet given,
  go with them, so others can claim the wish or end the group gift. Bought and given claims, and shares of a given
  group gift, stay without a giver and never named, so a received wish does not come back to its person, a
  thank-you does not go, and nobody buys a bought wish twice.
- **The person's path does the same work**: what the household has received is rebuilt once a day and after every
  change, in the request that makes the change; a person's reading requests only look it up, so their timing does not
  follow what is hidden from them.
- **The person's answers to gift routes** are a 403 decided from the wish and the caller alone, before any gift is
  read; nothing a giver does changes the wish's own row (its `updatedAt`, order, celebration).
- **Tests**: for every route, a matrix of viewer × wish (person, manager, other adult, kid, admin, share-link guest,
  draw-link guest) asserts on the raw response bytes that the claimer's id and name, the share amounts and the asker
  are absent where they must be (the Wishlist lesson: test the data, not the screen). M2's (`test/gifts.test.ts`)
  goes further for whoever may not see gifts: every reading answer must equal, byte for byte, the answer with no
  gifts at all, in every state before the celebration is over (a twin household with the same other changes, the
  clock pinned so both make them at the same moment: bodies and headers). M4's (`test/questions.test.ts`, `ideas.test.ts`, `guests.test.ts`) compares twin households the same way: who asked a
  question, whether ideas exist, whether a guest claimed; every viewer who may not know (the person, kids, the host,
  admins, other guests) gets the same bytes.
