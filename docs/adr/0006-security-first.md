# ADR 0006: Security first

Status: **Proposed** · 2026-11-24

**Decision**: Philobiblos' rules (its ADR 0009) apply: every route and job states which actor it is exposed to and
which control applies (`docs/security.md`); no passwords; every change carries Keepsake's own Origin; sessions
HttpOnly, Secure, SameSite=Strict; nothing public by itself; a red-team review before the first release.
