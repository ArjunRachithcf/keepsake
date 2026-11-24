# ADR 0001: HomersLab and standalone

Status: **Proposed** · 2026-11-24

**Decision**: Keepsake ships as a HomersLab catalog app and as a standalone Docker Compose app, like Philobiblos
(its ADR 0001): one image, `KEEPSAKE_MODE` = `homerslab` or `standalone`.

- `homerslab`: people, roles and the address come from HomersLab (manifest `contracts/homerslab-app.yaml`); Keepsake
  trusts the edge's `X-HomersLab-*` identity only from the configured proxy, and only once the edge promises to strip
  and set them (`KEEPSAKE_EDGE_IDENTITY=homerslab-v1`, HomersLab #236).
- `standalone`: passkeys only (as Philobiblos ADR 0010), a minimal household editor, SQLite in `/data`.
- Classic homelab (this household's box today) runs it as a component behind Caddy and Authentik until HomersLab
  replaces classic: the identity then comes from Authentik's forward-auth headers, trusted only from Caddy's fixed
  address, the same rules.
- **Consequences**: identity behind one interface; no HomersLab-only feature in core screens.
