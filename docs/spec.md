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
- **Kids** sign in and add their own wishes; a parent (a manager of their list) approves each before others see it.
  Kids never see claims on their own list. A kid's list is never shared outside the household unless a parent approves
  (decisions 2026-11-24).
- **Guests** (grandparents, friends outside the household): a **share link per list**, made by the list's owner (or a
  kid's parent): view and claim with a name, no account; revocable; hashed at rest; the token in the URL fragment.
  Guests see claims like any giver, never the owner's (decision 2026-11-24).

## 3. Core objects

| Object | Meaning |
|---|---|
| **List** | One per person (decision 2026-11-24: one list per person; the occasion is a note on each wish). Its **owner** is the person it is for; **managers** are the adults who keep it (a kid's parents) |
| **Wish** | Name, optional link, price (household currency, no default), quantity, note, priority (most wanted / high / normal / low), occasion tag. Added by the owner, a manager, or (as a suggestion) anyone |
| **Suggestion** | A wish someone else adds to your list: you see it and approve or decline it |
| **Idea** | A gift idea an adult keeps **for** a person, shared with the other givers, never shown to that person (decision 2026-11-24) |
| **Claim** | "I'll get this": who, how many, then *bought*. Seen by everyone except the list's owner (and, for a kid's list, except the kid) |
| **Exchange** | A draw-names event: name, date, budget, participants, exclusions (pairs who never draw each other, both ways), optionally "not the same as last year" |
| **Assignment** | One giver → one receiver in an exchange. Each giver sees only their own receiver; nobody sees the whole draw, admins included (ADR 0004) |

## 4. Screens

- **My list**: your wishes, drag to reorder, add by hand (from a shop link in M5); suggestions waiting for you; a
  kid's wishes waiting for a parent.
- **Family**: everyone else's lists; claim, mark bought, see who claimed what (never on your own list).
- **For you to give**: your exchanges, the person you drew, their list, the budget.
- **Ideas**: what the givers keep in mind for each person.
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
| **M4** | Sheet import; ideas; kids' wishes with a parent's approval; share links for guests |
| **M5** | Polish: PWA, Web Push, add from a shop link through Philobiblos' hardened egress (decision 2026-11-24) |
| **Gate** | A red-team review before the first release, as for HomersLab and Philobiblos |

## 7. Decisions (2026-11-24)

- **Kids**: sign in and add wishes; a parent approves each (Q1).
- **Guests**: a share link per list, view and claim with a name, revocable (Q2).
- **Ideas**: yes, kept for a person, shared with the other givers, never shown to the person (Q4).
- **Add from a link**: later (M5), only through a hardened egress; typed wishes first (Q6).
- Decided by default: the draw is revealed in the app ("For you to give"); a push says only "Your draw is ready",
  never the name, so a lock screen gives nothing away (Q3). Notifications are in-app and Web Push, as Philobiblos (Q5).

## 8. Not in scope

Buying, payment, shop integrations, price tracking, public registries for strangers.

## 9. Lessons from Wishlist (2026-11-24)

- Hide on the server, not in the interface; test the raw responses (page data and live updates) as the owner.
- Never let the first visitor become admin; never let a security setting live only in an editable database row.
- A sign-in through the identity provider must work on an empty install (Wishlist's first OIDC sign-in looped).
