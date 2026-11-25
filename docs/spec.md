# Keepsake: product spec (v0.2 draft, 2026-11-25)

## 1. Purpose

Keepsake keeps a family's **wishes**, the **celebrations** they are for, and the family's **draws** ("draw names"),
and keeps every surprise **on the server**: the person a gift is for never receives who claimed, bought or chipped in
for it, the ideas others keep for them, who asked them a question, or who drew them. Not just hidden on screen: absent
from every response they can get (ADR 0003).

Security comes first, then polish, then features (ADR 0006, `docs/security.md`). A HomersLab catalog app and a
standalone app (ADR 0001), with an iOS-like interface in HomersLab's design language (§4).

Why our own app: the household tried Wishlist (cmintey/wishlist) on 2026-11-24. Upstream hides claims on screen only
(its list data and live updates carried every claim; reported as cmintey/wishlist#867 with a fix in #868), has no
draw names (#797 open), reads none of its security settings from its environment and makes the first visitor its
admin. Lessons kept in §10.

## 2. People

- **Household**: from HomersLab (or the standalone household). Roles: admin, adult, kid.
- **Adults** keep their own wishes, see everyone else's, claim and chip in, keep ideas for others, ask anonymous
  questions, host celebrations and manage kids' wishes.
- **Kids** sign in and make wishes; a parent approves each before others see it. Kids never see claims on their own
  wishes. Kids don't draw names unless the celebration's host turns it on. A kid's wishes are shared outside the
  household only by a parent's link.
- **Guests** (people outside the household: a godmother, cousins) never get an account. Two kinds of link (ADR 0009):
  - a **share link** to one person's wishes, made by another grown-up of the household (a kid's: a parent), never
    by the person, since it shows what is taken: view and claim with a name;
  - a **personal draw link** to one celebration, made by its host: the guest joins that draw, sees their own person
    and that person's wishes for it; it expires when the celebration is over.

  Both revocable, hashed at rest, the token in the URL fragment. Guests see claims like any giver, never their own.

## 3. Core objects

| Object | Meaning |
|---|---|
| **Wish** | Belongs to the person it is for. Name, optional link, price (household currency, no default), quantity, note, *most wanted*. **For one celebration or for any time** (ADR 0007). Added by the person, a manager, or as a suggestion by anyone |
| **Celebration** | A date gifts are given for: Christmas, a birthday, the cousins' exchange. Name, date, place, poster, people. Owns the draw if it has one. Recurring ones (birthdays, Christmas) come back each year |
| **A celebration's list** (for a person) | Their wishes for that celebration plus their any-time wishes. A wish given once is gone everywhere |
| **Suggestion** | A wish someone else adds for you: you approve or decline it |
| **Idea** | A gift idea an adult keeps **for** a person, shared with the other givers, never shown to that person |
| **Claim** | "I'll get this": who, how many, then *bought*, then *given*. Seen by everyone except the person it is for |
| **Group gift** | A wish several people chip into: target, each one's share. Like claims, never shown to the person it is for |
| **Profile** | Sizes, likes and a "please no" list, kept by the person, dated ("sizes from October") |
| **Question** | An anonymous question to a person about their wishes: one question, one answer, no chat (ADR 0008) |
| **Draw** | Part of a celebration: budget, participants, exclusions (host only, both ways), optionally "not last year's person", *draw together* time, reveal date or never (ADR 0004) |
| **Assignment** | One giver → one receiver in a draw. Each giver sees only their own receiver until the reveal (ADR 0004) |
| **Thank-you** | After a celebration, the person thanks the givers who chose to put their name on the gift |

## 4. Screens (design canvas, round 3)

Three tabs, floating glass tab bar: **My wishes · Family · Celebrations**.

- **My wishes** (home): the next celebration ("Christmas in 30 days, your draw is ready to open"), celebration chips
  (All · Christmas · My birthday · Any time) filtering the list, questions waiting for an answer, "Add a wish for
  Christmas" rows, suggestions and a kid's wishes waiting for a parent.
- **New wish**: name, link, price, **For** (a celebration or any time), most wanted, note.
- **Family**: grown-ups, kids (with wishes to approve), guests' links. A person's page as a giver sees it: your draw for
  them, their sizes and likes, celebration chips, claim / chip in / mark bought, their answers, ideas for them,
  "Ask" and "Remind me".
- **Celebrations**: coming up (dates, "2 to approve", "2 cousins by link"); a celebration's page: poster, the sealed
  draw ("Open your draw", hide again), questions, everyone's state ("4 of 6 opened their draw"); new celebration (the
  host): poster, date, place, draw names, budget, draw together, who shouldn't draw whom, reveal date, kids draw too,
  people, invite a cousin by link.
- **Guest page** (browser): a share link or a draw link, with the guest's name before any claim.

Look: iOS 26 on phones: ground `#F2F2F7`, inset grouped lists, large titles 34 px, rows 17 px, secondary 15/13 px,
glass tab bar and buttons, spring animations, reduced motion honoured. The 17/34 phone sizes become HomersLab's
design tokens for all its apps (decision 2026-11-24). Installable (PWA). Logo: the Tied K (decision 2026-11-25).

## 5. Import

Once, from the household's Google Sheet ("Gift List" tab as CSV: Person, Item, Link, Priority, Status, Bought by,
Price, Occasion, Notes): Occasion maps to a celebration or any time; Reserved rows become claims by the person named in
"Bought by" when they match someone in the household. A dry run first; then the sheet is retired; household names stay
out of git (`seed/` is ignored). ADR 0005.

## 6. Notifications

In-app and Web Push. A push never names a gift, a giver or a drawn person ("Your draw is ready", "Leo answered your
question"), so a lock screen gives nothing away. Questions reach their person in the next morning's batch (ADR 0008).
"Remind me" sends one push a set time before a person's celebration.

## 7. Milestones

| | |
|---|---|
| **M0** | Repo, contracts, health page, image, compose, CI (the Philobiblos skeleton); logo and icons |
| **M1** | Identity and household (HomersLab headers, standalone passkeys); wishes for a celebration or any time; celebrations; profiles; suggestions |
| **M2** | Claims and group gifts, with the surprise invariant in one view layer, tested route by route (ADR 0003) |
| **M3** | Draws: exclusions, draw together, each giver's view, reveal date, re-draw (ADR 0004) |
| **M4** | Anonymous questions (ADR 0008); ideas; kids' wishes with a parent's approval; guest links (ADR 0009); sheet import |
| **M5** | Polish: PWA, Web Push, reminders, thank-yous, add from a shop link through Philobiblos' hardened egress |
| **Gate** | A red-team review before the first release, as for HomersLab and Philobiblos |

## 8. Decisions

2026-11-24:
- **Kids** sign in and make wishes; a parent approves each. They don't draw unless the host turns it on.
- **Guests**: a share link per person; and a personal link to join one celebration's draw, expiring after it.
- **Ideas**: kept for a person, shared with the other givers, never shown to the person.
- **Add from a link**: later (M5), only through a hardened egress; typed wishes first.
- **Wishes first, celebrations as the logic**: each wish is for one celebration or for any time.
- **Anonymous questions**: one question, one answer, no chat, delivered with the next morning's batch; the answers are
  visible to everyone giving to that person.
- **iOS type sizes** (17 px rows, 34 px titles) on phones for all HomersLab apps.
- Decided by default: the draw is opened in the app; a push never says the name.

2026-11-25: logo A, the Tied K.

2026-11-25 (M2, decided by default, open to change): kids see no claims or shares of anyone and do not claim; givers
see who chipped in and the total, not each other's amounts, and the shares together stay within the target; a wish
is either claimed or a group gift, not both; the person learns a gift was given on the day after the latest of the
occasion kept when it was marked given, the wish's current occasion and the day it was given, so the reveal only ever
moves later, and once revealed it stays revealed (ADR 0003); a giver who leaves the household takes their claims that
are only claimed and their shares of group gifts not yet given along, and leaves bought and given ones behind, unnamed.

2026-11-25 (M3, decided by default, open to change; ADR 0004): one draw per celebration and year; the host picks who
draws from the celebration's people, at least 4, under rules that let nobody work out another's person; while a draw
is secret, gifts between its people name no giver to anyone but the giver; a drawn draw's day only moves later; the reveal is a day after the celebration or never; re-draw after
someone opened theirs only before the day and not once a gift is bought since the draw; a re-draw is told in the app
(everyone opens theirs again), by push from M5; a celebration without a host has its draw run by an admin.

2026-11-25 (M4, decided by default, open to change; ADR 0005, 0008, 0009): a question reaches its person at 08:00 the day
after it was asked; kids do not ask, and a kid's questions go to the kid's parents, who answer them; 3 open questions per
asker and person; a declined question is shown to its asker only; ideas are for grown-ups other than the person, never
kids; one share link per guest (labelled), a guest session from the link (see below: on one device); guests see gifts without anyone's
name, the household sees a guest's claims with the guest's name (unless a draw keeps them unnamed); a guest invited
after the draw is a re-draw; the import maps unmatched occasions to any time and skips Bought rows.
Decided on PR #11: a kid does not see questions a parent answered for them (answers are for the givers); guests see
their person's sizes, likes and "please no" read-only (a draw guest their own person's only); a parent's "Add a wish
instead" on a kid's question offers the kid's celebrations; import rows are counted by sheet row. After its review:
a share link is made by another grown-up (a kid's: a parent), never by the person, and its address is shown only to
its maker, once; the person's pages list no link for them; a household session a link is not for cannot open it; a
guest's only-made claims go when they can no longer manage them; guests are marked as guests and never carry a
household member's name; a Reserved row with an unknown buyer is an imported reservation an admin can release; ideas
show only their day; no guest link under HomersLab until Homeward #317.
After its second review: a link opens on one device (the first exchange spends it, the session lasts as long as the
link, another device is told it was opened elsewhere, its maker sees "opened"); a guest session left in a browser
never opens with a household session it is not for.
After its third review: one browser keeps every link it opened (a device cookie; each guest request names its link);
a link's managers give it a new address (the same guest, place, pair and claims); the guest page sends nothing until
Open; a guest session ends after 30 days unused and at a household sign-in in that browser.

Decided by default (open to change): a giver chooses, per gift, whether the person learns their name after the
celebration (for thank-yous); exclusions are seen by the host only; the reveal date is the host's choice, "never" by
default.

## 9. Not in scope

Buying, payment, shop integrations, price tracking, public registries for strangers, chat.

## 10. Lessons from Wishlist (2026-11-24)

- Hide on the server, not in the interface; test the raw responses (page data and live updates) as the owner.
- Never let the first visitor become admin; never let a security setting live only in an editable database row.
- A sign-in through the identity provider must work on an empty install (Wishlist's first OIDC sign-in looped).
