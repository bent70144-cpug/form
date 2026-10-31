# ADR 0002 — UUID strategy

**Status:** Accepted · **Ticket:** 01 · **Date:** 2026-10-31

## Context

The spec requires time-sortable internal IDs (UUIDv7) and ties Better Auth
user IDs to the alpha spike decision: either Better Auth generates UUID user
IDs, or the app uses text IDs consistently in `app.user_id` and policies. The
two representations must never diverge.

## Decision

- **Internal domain IDs** (workspaces, forms, versions, sessions,
  submissions, audit events) are **UUIDv7, generated in the application**
  by `uuidv7()` from `@form/database` (pure TypeScript, RFC 9562). No
  Postgres extension is required, which keeps local, Neon, and embedded
  environments identical. `gen_random_uuid()` (UUIDv4) remains acceptable
  only as a documented server-side default where sortability does not matter.
- **Better Auth user IDs** are pinned to UUID output in the auth package
  (ticket 02 records the exact Better Auth setting for the pinned version;
  ticket 03 wires it). App tables store user IDs as `uuid` and all tenant
  policies compare against the same UUID representation.

## Consequences

- No dependency on `pg_uuidv7` availability.
- IDs sort lexicographically by creation time, giving cursor pagination
  stable, index-friendly ordering.
- If the pinned Better Auth version cannot emit UUIDs, the fallback is text
  IDs everywhere (`app.user_id text`) — a single migration-time decision,
  never a runtime mix.
