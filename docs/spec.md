# Keepsake: product spec (v0.1 draft, 2026-11-24)

## 1. Purpose

Keepsake keeps a family's **wish lists** and its **gift exchanges** ("draw names"), and keeps every surprise **on the
server**: the person a gift is for never receives who claimed or bought it, the ideas others keep for them, or who drew
them. Not just hidden on screen: absent from every response they can get (ADR 0003).

Security comes first, then polish, then features (ADR 0006, `docs/security.md`). A HomersLab catalog app and a
standalone app (ADR 0001), with a modern UI in HomersLab's design language.

Why our own app: the household tried Wishlist (cmintey/wishlist) on 2026-11-24. Upstream hides claims on screen only
(its list data and live updates carried every claim; reported as cmintey/wishlist#867 with a fix in #868), has no
draw names (#797 open), reads none of its security settings from its environment and makes the first visitor its
admin. Lessons kept in §9.

## 2. People

- **Household**: from HomersLab (or the standalone household). Roles: admin, adult, kid.
- **Adults** have their own list, see everyone else's lists, claim wishes, keep ideas for others, take part in
  exchanges, and manage kids' lists.
- **Kids** have a list that adults manage (open question Q1: do kids sign in and add wishes themselves?). A kid's list
  is never public unless an adult approves (decision 2026-11-24).
- **Guests** (grandparents, friends outside the household): open question Q2.

## 3. Core objects

| Object | Meaning |
|---|---|
| **List** | One per person (decision 2026-11-24: one list per person; the occasion is a note on each wish). Its **owner** is the person it is for; **managers** are the adults who keep it (a kid's parents) |
| **Wish** | Name, optional link, price (household currency, no default), quantity, note, priority (most wanted / high / normal / low), occasion tag. Added by the owner, a manager, or (as a suggestion) anyone |
| **Suggestion** | A wish someone else adds to your list: you see it and approve or decline it |
| **Idea** | A gift idea someone keeps **for** a person: never shown to that person (open question Q4) |
| **Claim** | "I'll get this": who, how many, then *bought*. Seen by everyone except the list's owner (and, for a kid's list, except the kid) |
| **Exchange** | A draw-names event: name, date, budget, participants, exclusions (pairs who never draw each other, both ways), optionally "not the same as last year" |
| **Assignment** | One giver → one receiver in an exchange. Each giver sees only their own receiver; nobody sees the whole draw, admins included (ADR 0004) |

## 4. Screens

- **My list**: your wishes, drag to reorder, add from a link (Q6) or by hand; suggestions waiting for you.
- **Family**: everyone else's lists; claim, mark bought, see who claimed what (never on your own list).
- **For you to give**: your exchanges, the person you drew, their list, the budget.
- **Ideas** (Q4): what you keep in mind for each person.
- **Household** (admins): people, kids' managers, exchanges (create, draw, re-draw), import.

Phone first; installable (PWA). No live claim stream to a list's owner, by construction.

## 5. Import

Once, from the household's Google Sheet ("Gift List" tab as CSV: Person, Item, Link, Priority, Status, Bought by,
Price, Occasion, Notes; decision 2026-11-24: import once, then retire the sheet). Bought rows stay in the sheet;
Reserved rows become claims by the person named in "Bought by" when they match someone in the household, else plain
wishes listed for that person to claim again. A dry run first; household names stay out of git (`seed/` is ignored).

## 6. Milestones

| | |
|---|---|
| **M0** | Repo, contracts, health page, image, compose, CI (the Philobiblos skeleton) |
| **M1** | Identity and household (HomersLab headers, standalone passkeys), lists and wishes, suggestions |
| **M2** | Claims, with the surprise invariant enforced in one view layer and tested route by route (ADR 0003) |
| **M3** | Exchanges: draw with exclusions, each giver's view, re-draw, last year's pairs (ADR 0004) |
| **M4** | Sheet import; ideas (Q4); kids' managers and approvals |
| **M5** | Polish: PWA, add from a link through a hardened egress (Q6), notifications (Q5) |
| **Gate** | A red-team review before the first release, as for HomersLab and Philobiblos |

## 7. Open questions (for the maintainer)

- **Q1 Kids**: do kids sign in and add their own wishes (adults approve), or do adults keep kids' lists entirely?
- **Q2 Guests**: who outside the household sees lists, and can they claim? (A share link per list, view-and-claim,
  revocable? Or guests as light accounts in HomersLab's sign-in?)
- **Q3 Draw reveal**: in the app only, or also a message (mail / push) with your person?
- **Q4 Ideas**: keep secret ideas for others (never shown to the person)? Wishlist's "Surprise me" did this badly.
- **Q5 Notifications**: "someone suggested a wish", "the draw is done": in-app only, Web Push, or HomersLab's ntfy?
- **Q6 Add from a link**: fetch a shop page's title, price and picture? It means Keepsake fetches pages on the
  internet (a hardened egress like Philobiblos'); without it people type wishes by hand.

## 8. Not in scope

Buying, payment, shop integrations, price tracking, public registries for strangers.

## 9. Lessons from Wishlist (2026-11-24)

- Hide on the server, not in the interface; test the raw responses (page data and live updates) as the owner.
- Never let the first visitor become admin; never let a security setting live only in an editable database row.
- A sign-in through the identity provider must work on an empty install (Wishlist's first OIDC sign-in looped).
