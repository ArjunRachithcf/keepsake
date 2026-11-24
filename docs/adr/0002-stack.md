# ADR 0002: Stack

Status: **Proposed** · 2026-11-24

**Decision**: Philobiblos' stack (its ADR 0002): TypeScript end to end, Node 22 + Fastify, SQLite via Drizzle,
React + Vite, pnpm monorepo (`apps/server`, `apps/web`, `packages/contracts`, `packages/draw`).

- **Why**: one stack across HomersLab's apps; its security work (sessions, Origin checks, passkeys, egress, the
  architecture tests) carries over; SQLite fits a family and HomersLab's backups.
- `packages/draw`: the draw as pure functions (no I/O), tested exhaustively.
