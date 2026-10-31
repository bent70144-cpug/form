# ADR 0003 — Alpha topology spike: single-service GO

**Status:** Accepted · **Ticket:** 02 · **Date:** 2026-10-31

## Context

Ticket 02 was a two-day, decision-producing spike. It had to prove or disprove
the single-service alpha topology: Next.js on the public port, NestJS on an
internal port, Better Auth mounted in NestJS under `/v1/auth`, one Postgres
with role/schema separation (`app`, `auth`, `pgboss`, migrator/app_user/
worker_user/NOLOGIN fn_owner), a pg-boss heartbeat worker, and a
migration-before-deploy pipeline. Every assumption carried a named fallback
(see the decision table); this record is the written go/no-go.

Sandbox note (ADR 0001): Docker is unavailable, so Postgres was exercised as
real PostgreSQL 17 binaries via `embedded-postgres` (localhost:5433) with the
same roles/RLS as Neon. Neon/Render/email paths are implemented as code +
runbooks (`.github/workflows/deploy.yml`) and marked "requires credentials".

## Decision table (assumption → fallback → spike verdict)

| Assumption | Fallback if it failed | Verdict |
| --- | --- | --- |
| Better Auth mounts in NestJS under `/v1/auth` (Drizzle adapter, `auth` schema) | Run auth in **Next.js**, keep the session-endpoint boundary (web owns `/v1/auth/*` only) | **Works** — sign-up → `Set-Cookie` → `get-session` round-trip green against real Postgres (`apps/api/test/auth-roundtrip.test.ts`) |
| Next.js rewrites `/v1/*` → NestJS; supervisor allowlists child envs | **Two services** (separate web/API deploys, public API origin) | **Works** — rewrite hops internally (`apps/web/next.config.ts`), allowlist enforced fail-closed (`packages/config/test/supervisor.test.mjs`, `scripts/supervisor.mjs`) |
| Neon roles + `fn_owner` security-definer policies work **without `BYPASSRLS`** | **Switch the Postgres host** before feature work | **Works** — forced-RLS tenant tests + `fn_owner` functions pass as non-superuser roles on PG 17 (ticket 05 suite, `packages/database/test/*`) |
| Render free can run migrations pre-deploy | (none viable on free tier) → **GitHub Actions migrate-before-deploy is the primary path** | **Confirmed constraint** — Render free has no pre-deploy command; `deploy.yml` runs migrations as `migrator` (GitHub secret only), then triggers the Render deploy hook; Render auto-deploy on push must be disabled |

## Pinned versions (alpha)

| Package | Pin | Why |
| --- | --- | --- |
| `better-auth` | **1.7.14** | Drizzle adapter; `advanced.database.generateId`; compiled Kysely DDL accepts `schemaName` for the DDL step |
| `pg-boss` | **12.38.0** | v12 skips its own migration with `migrate: false` (see below) |
| `drizzle-orm` | **0.45.4** | `pgSchema("auth")` / `pgSchema("pgboss")` qualification, used by both the API and the migrator |
| `next` | **16.4.3** | Native `next.config.ts`, async `rewrites()` |
| `@nestjs/*` | **12.3.2** | Express platform, global `/v1` prefix, route mounting order verified |

## UUID decision (closes ADR 0002's ticket-02 clause)

Better Auth **1.7.14 supports UUID user IDs** — pinned setting, exactly:

```ts
advanced: { database: { generateId: () => uuidv7() } }
```

(`uuidv7()` from `@form/database`). IDs stay stored in Better Auth's `text`
columns but carry UUIDv7 values, so `app.user_id uuid` and every tenant
policy compare one representation. Verified in the round-trip test
(`isUuid(signUp.body.user.id) === true`). The ADR-0002 text-ID fallback is
**not** used.

## Auth schema ownership

Better Auth's tables (`user`, `session`, `account`, `verification`) live in
the non-public **`auth` schema** — qualification is in the drizzle
`pgSchema("auth")` table definitions (1.7.14 has no string `useSchema`
option; the adapter's `schemaName` drives its CLI/DDL generator only). In the
spike's test setup the tables are created by Better Auth's own compiled DDL
run **as the admin/superuser**, with runtime DML grants to `app_user`
(no CREATE — asserted 42501). **In production migrations own these tables**:
the compiled DDL lands in a migrator migration and `app_user` only ever gets
DML grants.

## pg-boss heartbeat: interval and skip-migration findings

- **Interval: 30 s** (`*/30 * * * * *`, `DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000`).
  A 30 s recurring schedule **does keep Neon awake** (Neon free suspends after
  ~5 min idle), which is the chosen alpha trade-off: bounded dispatch latency
  and simple scheduling over compute-idle savings. The documented alternative
  is to widen the interval beyond the suspend threshold (e.g. ≥ 5 min, or no
  heartbeat at all and rely on the outbox path) if Neon cost becomes a
  concern — ticket 05 re-decides with real dispatch traffic. Non-divisor
  cadences fall back to RFC 5545 `FREQ=SECONDLY;INTERVAL=n`.
- **Cron-monitor finding (pg-boss 12.38.0):** with its defaults
  (`cronMonitorIntervalSeconds = 30`, `cronWorkerIntervalSeconds = 5`) a
  schedule created after `start()` produces its first job only after up to
  ~35 s — long enough to flake a 15 s test window and to add up to 30 s of
  dispatch jitter. The worker therefore pins `cronMonitorIntervalSeconds: 5`
  and `cronWorkerIntervalSeconds: 5` (both allowed 1..45), bounding
  first-job latency to roughly the interval + 10 s with negligible extra
  Neon load (a handful of cheap polls per minute — still "keeps awake", by
  design, per the 30 s choice above).
- **Skip-migration option finding (pg-boss 12.38.0):** the runtime worker
  starts with `migrate: false, createSchema: false` — the `pgboss` schema is
  installed by the **migrator** (a migration in production; the migrator-role
  install step locally). The `migrations: { skipMigration: true }` shape found
  in older docs is pg-boss 9/10 and does **not** exist in v12.
- **PostgreSQL 17 ACL finding:** `CREATE SCHEMA IF NOT EXISTS` still demands
  CREATE on the database even when the schema already exists, so the install
  must run with `createSchema: false` against a pre-created, migrator-owned
  `pgboss` schema (`apps/worker/src/index.ts`, `installPgBossSchema`).
- Verified: scheduled heartbeat fires as `worker_user` (DML-only), pgboss
  tables stay migrator-owned, `worker_user` CREATE is rejected (`apps/worker/test/heartbeat.test.ts`).

## Hop observations behind the local `/v1/*` rewrite

Through `next dev`'s `/v1/:path*` rewrite, NestJS sees the **peer address
`127.0.0.1`** — the Next process is the immediate TCP peer; there is no
reachable client IP unless a proxy appends forwarded headers. Next's rewrite
proxy does not give Nest a trustworthy `X-Forwarded-For` chain by itself, so
client-IP derivation must trust only a deliberate reverse proxy (Render's
platform proxy in alpha). Spike instrumentation records the hop as
`x-spike-peer-address` / `x-spike-forwarded-headers` response headers
(`apps/api/src/health.controller.ts`, removed at ticket 04). Runbook:

```
node scripts/supervisor.mjs --dev            # boots pg + web(3000) + api(4000) + worker
curl -si http://localhost:3000/v1/health | grep -i x-spike
# → x-spike-peer-address: 127.0.0.1   (what Nest sees behind the rewrite)
```

Ticket 04's trusted-proxy tests must assert the real hop chain against these
observations (direct in-process hop = loopback; behind Next rewrite =
`127.0.0.1` from the Next process; behind Render = platform proxy).

## Pooled vs direct connection split

- **App (web→API runtime): pooled `DATABASE_URL`** as `app_user`
  (Neon pooled endpoint / pg-bouncer in production).
- **Migrator and pg-boss: direct URL** — `MIGRATOR_DATABASE_URL` (migrator
  role, migrations + pgboss DDL) and `WORKER_DATABASE_URL` (worker_user,
  heartbeat/dispatch). Transaction-mode pooling breaks session-scoped
  features (advisory locks, session GUCs), so the queue and the migrator
  never share the pooled path.
- Context-leak proof on a pooled connection: `app.user_id`/`app.workspace_id`
  are set with `set_config(..., true)` and are **empty immediately after the
  transaction ends** (`packages/database/test/tenant.test.ts`, "sets
  app.user_id and app.workspace_id transaction-locally") — transaction-local
  context does not leak between requests.

## Consequences

- **GO for the single-service alpha.** No fallback from the decision table is
  activated; each fallback stays valid escape hatches if a live-credential
  environment contradicts the spike.
- Process-level separation only (supervisor allowlist) — real separation
  arrives with the beta split; the web child is fail-closed on forbidden keys.
- Render deploy order is load-bearing: GitHub Actions migrate (migrator URL
  as a GitHub secret, never in Render runtime) → deploy hook → traffic.
  Render auto-deploy disabled.
- No product features were built in this spike; the outbox dispatcher begins
  in ticket 05.
