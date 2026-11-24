# ADR 0005: Import once

Status: **Proposed** · 2026-11-24

**Decision**: A one-time import of the household's Google Sheet ("Gift List" tab, CSV), dry run first; then the
sheet is retired (decision 2026-11-24). No sync. The import runs as an admin action on a file the admin uploads;
names in the file are matched to people in the household or listed for the admin to map; nothing of the file is
kept after the import except the wishes and claims it made.
