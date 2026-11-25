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
person, not a kid); Bought (or Given) rows are skipped; Priority "High", "Most wanted" or "1" is most wanted. Limits:
512 KB, 2000 rows. A cell's leading `=`, `+`, `-`, `@`, tab or CR is dropped. A fictional sample is in `seed-sample/`.
