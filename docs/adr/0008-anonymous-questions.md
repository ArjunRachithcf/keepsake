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
