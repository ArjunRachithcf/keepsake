# ADR 0008: Anonymous questions

Status: **Proposed** · 2026-11-25

**Decision**: A giver can ask a person one anonymous question about their wishes ("Leather or cotton gloves?"). One
question, one answer, no chat. The asker is never sent to the person.

- **Timing**: questions are delivered to their person in one morning batch (08:00 household time), never right after
  they are asked, so the moment a question arrives can't point at who was online.
- **Who sees the answer**: everyone giving to that person (the household's adults and guests with a link to them);
  the question shows without its asker to everyone, the asker included sees it marked "yours".
- **Storage**: the asker is kept (so the asker can find it and so it can be removed) but only `viewFor` reads it, and
  never for the person asked (ADR 0003's tests cover it).
- **Limits**: a few open questions per asker and person; the person can decline or answer with a wish instead ("Add a
  wish instead"); admins can remove an abusive question without learning more than the person did.
- Kids can be asked; their parent sees the question first, like a kid's wish.

**M4, decided by default (2026-11-25, open to change)**:

- **The batch** is 08:00 household time on the day *after* a question is asked, so the sheet can always say "gets it
  tomorrow at 8:00". Computed when read (`deliver_at`); until then only the asker sees it, and everyone else's
  answers are byte for byte those with no question. Ids are random, not ULIDs, so an id carries no time.
- **Who asks**: grown-ups and guests. Not the person, not a kid's own parent (they keep the list), not kids (they make
  no gifts in M4, as for claims).
- **A kid's questions** go to the kid's parents, who answer, decline or add a wish for the kid. The kid does not see
  questions (passing one on to the kid is left for later).
- **Limits**: 3 open questions per asker and person, 30 delivered open ones per person (only delivered ones count:
  everyone giving sees those, so the refusal says nothing about questions on their way; review of PR #11).
- **Kids** see no question at all, not even one answered for them (a 404 on every route, as for none).
- **Declined** questions are shown to their asker only ("they'd rather not say"); everyone else sees nothing.
- **Taking back**: the asker until the batch; after it only an admin removes one, audited as who removed which.
- **Storage**: only `questions/questions.ts isAsker` reads the asker, comparing it with the caller; nothing returns it.
