# ADR 0010: Notices, Web Push, reminders and thank-yous

Status: **Proposed** · 2026-11-25 (M5, decided by default, open to change)

**Context**: spec §6 asks for in-app notifications and Web Push that never name a gift, a giver or a drawn person;
ADR 0004 promised a push for a re-draw; ADR 0008 put questions in a morning batch; spec §3 has thank-yous. A push is
seen on a lock screen, passes through a push service run by someone else, and its arrival time is a signal of its own.

**Decision**: What is new for a person is a **notice**, a pointer kept in Keepsake; a **push** only says that
something is new.

- **A notice is a pointer**: its kind and what it is about (a celebration, a question, a thank-you) and a day, never
  its content. `GET /api/notices` builds each with `viewFor`, by the rules every other answer follows, when it is read;
  one that points at nothing the person may see any more is left out. Its id is a hash of (person, kind, subject,
  day): the same notice is made once, and no id carries a moment.
- **Only what the person may know makes a notice**: a question that reached them (a kid's: their parents), the answer
  to their own question, names drawn, drawn again or cleared in a draw they are in, a celebration a week away (its
  people), "Remind me", a draw's reveal date (its people and host), gifts that reached them (after the occasion, as
  `thanks` shows them), a thank-you for a gift they gave. Never a claim, a share, an idea, a question on its way or its
  asker, someone else's reminder, or a pair. The twin-household matrices of M2–M4 read `/api/notices` after running
  the batch, and count the pushes each person was sent, so a notice or a push that followed a hidden thing fails them.
- **A push is one fixed message**: `{"v":1}`, encrypted (RFC 8291, aes128gcm, padded) for every device, so the push
  service sees the same few bytes each time; the service worker shows "Something new in Keepsake" and nothing from
  the push; Keepsake opens on My wishes and reads the news through the API, as the person. One topic (`keepsake`), a
  day to live: a push not yet delivered is replaced, not stacked.
- **Pushes leave from a queue**, after the request that caused them has answered, so no answer's timing depends on a
  push service. They go only through the egress client (ADR 0011) and only to a known push service (Google, Mozilla,
  Apple, Microsoft): a subscription's endpoint is checked when it is made, so a subscription cannot point Keepsake at
  the household's network. A 404 or 410 drops the subscription; so do five failures in a row.
- **The VAPID key** is kept like the sealing key (ADR 0004): `KEEPSAKE_VAPID_KEY` or `_FILE`, under HomersLab a secret;
  standalone makes `keys/vapid.key` once (0600), never in `data/`. Without it, or with `KEEPSAKE_EGRESS=off`, there is no
  push; the notices still show in the app.
- **A device's subscription is its session's** (standalone): signing out, or a lost device's sessions ended, ends it,
  so a family computer someone signed out of gets nothing more for them. At most 10 devices a person.
- **The morning batch** (ADR 0008's 08:00, household time): questions that reached their person, celebrations a week
  away, "Remind me", reveal dates and gifts received, for everyone at once. It runs once a day (`job_run`); a server
  that was off at 08:00 runs it at its next start that day, catching up a week of questions, reveals and thank-you
  prompts (reminders only on their day). Answers to a question, draws and thank-yous are told at once: only the person
  told could learn anything from their timing, and they know it already.
- **"Remind me"** (`PUT /api/people/{id}/reminder`): 1 to 60 days before each of that person's celebrations, at the
  batch; the caller's own, never about themselves; `PersonPage.reminder` shows only the caller's, so nobody learns
  who keeps a reminder about them. A celebration's own people are reminded a week before without asking.
- **Thank-yous** (`PUT /api/wishes/{id}/thanks`): once a gift has reached its person (it is in their `thanks`), the
  person, or a kid's parent with the kid, writes one thank-you for it, once. It goes to every household giver of it,
  named or not; a giver reads it in `GET /api/home` `thanked`. Its writer is never told who received it: the answer
  and every later read are the same whoever gave and however many did (`test/notices.test.ts`). Before the gift
  reaches its person the route is the 404 a wish without a gift gets. Guests who gave get no thank-you (they have no
  inbox; the household can tell them in person).
- **Guests** get no notices and no push (they have no account).

**Consequences**: a few new tables (`notice`, `push_subscription`, `reminder`, `thank_you`, `job_run`); one egress
client in the server (ADR 0011); the service worker (`apps/web/public/sw.js`) also keeps the offline shell, and never
touches `/api`. Accepted: the push service learns when a device gets something (not what); a push can arrive while
the screen is unlocked next to someone else, and says only "Something new". Under HomersLab a subscription has no
Keepsake session to end with: it ends when the person turns notifications off on that device, the browser drops it,
or the person leaves the household.
