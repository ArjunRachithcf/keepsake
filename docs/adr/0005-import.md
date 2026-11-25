# ADR 0005: Import once

Status: **Proposed** · 2026-11-24

**Decision**: A one-time import of the household's Google Sheet ("Gift List" tab, CSV), dry run first; then the
sheet is retired (decision 2026-11-24). No sync. The import runs as an admin action on a file the admin uploads;
names in the file are matched to people in the household or listed for the admin to map; nothing of the file is
kept after the import except the wishes and claims it made.

**M4 (2026-11-25)**: `POST /api/import/dry-run` then `POST /api/import`, with the same file and the names mapped
(`people`: a name → someone or null to skip their rows; `occasions`: an occasion → a celebration or null for any
time). Names and occasions match case-insensitively; an unmatched occasion is any time unless mapped; a celebration the
person is not part of becomes any time. Reserved rows become claims by the "Bought by" household member (not the
person, not a kid), and a Reserved row whose buyer is nobody here who may give becomes nobody's **imported
reservation** (review L1: so nobody buys it twice; givers see "An imported reservation", an admin releases it,
audited); Bought (or Given) rows are skipped; Priority "High", "Most wanted" or "1" is most wanted. Limits:
512 KB, 2000 rows. A cell's leading `=`, `+`, `-`, `@`, tab or CR is dropped. A fictional sample is in `seed-sample/`.

**Accepted (second review of PR #11)**: an imported reservation on an admin's own wish is released by another admin
only: its person is refused like any giving, before any claim is read, so the answer says nothing. A household whose
only admin has one keeps it (the wish stays taken for givers) until a second admin releases it or the wish goes.

**Accepted (review L2)**: the dry run's plan shows the admin who runs it the claims and buyers of every row, their own
wishes' included. They hold the file, which says the same; Keepsake keeps none of it.
