# Keepsake

**Wishes, celebrations and draws for a family, the surprise kept.**

Keepsake keeps everyone's wish lists and draws names for gift exchanges. Who is getting what, and who drew whom,
never reaches the person a gift is for: not on screen, and not in anything the server sends them.

A HomersLab app (with Homeward and Philobiblos) and a standalone app. Status: M5 (wishes, celebrations, claims and
group gifts, draws, questions, ideas, guest links, the sheet import; installable, notifications, reminders, thank-yous,
add from a shop link); a red-team review comes before the first release. Standalone: `mkdir -m 700 data && docker compose up -d`, then open the
one-time link in `data/setup-link.txt` to make the first admin's passkey. Design (v0.2 draft):
[`docs/spec.md`](docs/spec.md), [`docs/security.md`](docs/security.md), [`docs/adr/`](docs/adr/).

The name: in Homer, a house keeps its treasured gifts (*keimelia*) in the storeroom, to give and to hand on.

Licence: Apache-2.0.
