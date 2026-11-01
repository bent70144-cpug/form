# ADR 0005 — Outbox dispatcher: claims, backoff, dead-letter, restart safety

**Status:** Accepted · **Ticket:** 05 · **Date:** 2026-10-31

## Context

Ticket 05 introduces the first outbox producer (`create_personal_workspace()`
inserts `workspace.created` with payload `{ workspaceId, userId }`; migration
0006). Migration 0003 already created `app.outbox_events` (no `workspace_id`
column — the payload carries IDs) with INSERT-only access for `app_user` and
SELECT/UPDATE for `worker_user`. The spec requires: a pg-boss scheduled
dispatch using the ticket-02 interval strategy; claims via
`FOR UPDATE SKIP LOCKED`; retries with backoff; a dead-letter state after 10
attempts; and a worker restart that neither loses nor double-processes an
in-flight event.

## Decision

### Claim algorithm (`packages/queue/src/outbox/dispatcher.ts`)

One dispatcher tick = one transaction:

```sql
BEGIN;
SELECT id, event_type, payload, attempts
  FROM app.outbox_events
 WHERE processed_at IS NULL AND dead_lettered_at IS NULL
   AND available_at <= now()
 ORDER BY available_at, id
 LIMIT 25
 FOR UPDATE SKIP LOCKED;          -- concurrent dispatchers claim OTHER rows
UPDATE app.outbox_events
   SET dispatched_at = COALESCE(dispatched_at, now())  -- in-flight marker
 WHERE id = ANY($1::uuid[]);
-- per event: run the registered handler
--   success → processed_at = now(), last_error = NULL
--   failure → attempts = attempts + 1, last_error = <truncated 2000 chars>,
--             available_at = now() + backoff(attempts)   (or dead-letter)
COMMIT;
```

The whole batch commits atomically; per-event handler failures are recorded
inside the transaction (they are *expected* outcomes, not errors), so a batch
never half-commits. No `app.user_id` / `app.workspace_id` GUC is set:
`outbox_events` is not a tenant table (no RLS — see
`packages/database/src/tenant-tables.ts`, which intentionally excludes it, and
the catalog guard skips it for the same reason). Handlers that read tenant
tables must open their own `withTenantTransaction` under the non-bypass
`worker_user` and set `app.workspace_id` from the payload.

### Backoff schedule

`backoff(n) = min(1s · 2^(n−1), 10 min)` after failed attempt *n*:
1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s. Stored as
`available_at = now() + make_interval(secs => …)` so the dispatch scan
(`available_at <= now()`, partial index `outbox_events_dispatch_idx`) simply
ignores future rows — no timers to lose across restarts. The 10-minute cap
bounds the worst-case delay for pathological events.

### Dead-letter policy

The **10th failed attempt** sets `dead_lettered_at = now()`; dead-lettered
rows leave the scan entirely (they are kept for inspection — no deletion in
M0) and stop consuming retry cycles. The threshold is `DEFAULT_MAX_ATTEMPTS =
10`, per spec. A registered-but-failing handler and an *unregistered* event
type both follow this path (an unknown type must not poison the scan forever);
`last_error` preserves the reason.

### Restart safety

The claim (`FOR UPDATE SKIP LOCKED`) lives in the SAME transaction as the
handler execution and the `processed_at` update. A worker that dies
mid-handler leaves its transaction open only until the connection drops —
PostgreSQL then rolls it back, the row is again unprocessed/available, and a
later tick redelivers it. Consequences:

- An event is never lost (the claim is durable only through the commit).
- An event is never double-*processed* (two dispatchers cannot hold the same
  row; a redelivered event re-runs the handler — see below).
- `dispatched_at` (first-claim timestamp) is best-effort observability: it
  rolls back with a crashed claim by design.

This is tested by killing the backend mid-claim (`pg_terminate_backend`) and
proving redelivery applies the handler effect exactly once.

### Handler idempotency contract (registered handlers MUST satisfy)

1. A handler may be invoked MORE THAN ONCE per event (crash between the
   handler's side effect and the claim COMMIT, or a redelivery after any
   rollback). Key the effect on the event `id` and make replays no-ops —
   unique constraint + `ON CONFLICT DO NOTHING`, or a naturally replayable
   effect (structured logging; the M0 `workspace.created` handler).
2. The handler runs while the event row is locked inside the dispatcher
   transaction — it must not assume the claim has committed.
3. The handler owns its own connections/transactions for side effects;
   anything it commits externally survives a dispatcher rollback — which is
   exactly why rule 1 exists.

### Why a direct connection + worker_user

- pg-boss needs session-scoped features (advisory locks); transaction-mode
  pooling can break them — the spec pins pg-boss to the DIRECT URL
  (`WORKER_DATABASE_URL`), never the pooled app URL. The dispatcher's claim
  transaction additionally relies on row locks held for the tick's duration.
- The dispatcher pool is `createPool(url, { tenantGuard: false })`: the
  tenant-query guard exists for tenant tables and `outbox_events` is not one
  (verified against `TENANT_TABLES`). `worker_user` has SELECT/UPDATE — and
  nothing else — on the outbox, no `BYPASSRLS`, and cannot read tenant rows
  outside a tenant transaction context, so the least-privilege shape is
  preserved.
- pg-boss runs with `migrate: false; createSchema: false` (ticket 02 finding):
  DDL belongs to the migrator; the runtime role is DML-only
  (`installPgBossSchema` / `grantPgBossRuntimeRole` from `@form/queue` are the
  dev/test/bootstrap companions; production uses a migration).

### Scheduling

`outbox.dispatch` is a recurring pg-boss schedule every 30s
(`heartbeatCron(HEARTBEAT_INTERVAL_MS)` → `*/30 * * * * *`, the ticket-02
interval strategy — bounded dispatch latency without keeping Neon awake).
`HEARTBEAT_INTERVAL_MS` (Zod-validated in `packages/config/src/env.ts`,
default 30s) is the single source of truth for BOTH the heartbeat and the
dispatch cadence; the worker entrypoint wires it to both schedules. The
`outbox.dispatch` and `heartbeat` queues use the `singleton` policy so a slow
tick never stacks with the next one; the cron monitor stays at 5s so a
freshly-started worker's first tick lands within ~interval + 10s.

pg-boss 12.38 finding (verified while testing the adapter): the timekeeper
files each cron occurrence into a **60-second throttle slot** — one job per
slot, so any sub-minute cron expression (30s, 1s, …) effectively fires at most
**once per minute**. The 30s strategy therefore degrades to ~1 tick/minute,
which is acceptable for outbox dispatch (throughput, not latency, matters at
this cadence) and further reduces Neon wake-ups. Producers that ever need
lower latency can enqueue the `outbox.dispatch` job directly
(`queue.enqueue("outbox.dispatch", {})`) right after committing a batch of
events; the schedule remains the safety net.

## Consequences

- `@form/queue` now depends on `@form/database` (pool helper) and `pg-boss`;
  the `JobQueue` port itself needed no changes — registerHandler/enqueue/
  schedule map 1:1 onto `boss.work`/`boss.send`/`boss.schedule`.
- The `PgBossQueueStub` from ticket 01 is replaced by `PgBossJobQueue`; the
  in-memory adapter is unchanged.
- Handlers registry lives with the worker wiring (`apps/worker`); the
  dispatcher package stays generic by `event_type`.
- Dead-letter review tooling is out of scope for M0; rows are inspectable via
  SQL (`dead_lettered_at IS NOT NULL`).
