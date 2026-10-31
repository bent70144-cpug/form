# 02: Alpha topology spike

**Spec:** `../spec.md`

**What to build:** A two-day, decision-producing spike that proves or disproves the single-service alpha topology and the auth, database-role, queue, and deployment assumptions before feature work begins.

**Blocked by:** 01

**Status:** done

- [x] The spike is time-boxed to two working days and ends with a written go/no-go decision.
- [x] A supervisor starts Next.js on the public port, NestJS on an internal port, and the inline worker locally. The supervisor spawns each child with an explicit allowlisted environment; the Next process receives only public variables and the internal API URL, never `DATABASE_URL`, auth secrets, or the migrator URL. A test fails if a forbidden key appears in the Next process environment. This is process-level separation only; real separation arrives with the beta split.
- [x] Next.js rewrites `/v1/*` to NestJS; a browser request reaches NestJS and a `Set-Cookie` response round-trips.
- [x] Better Auth is mounted in NestJS under `/v1/auth`, uses Drizzle in the non-public `auth` schema, and completes a sign-up/session round trip. The spike records the exact setting for the pinned Better Auth version to generate UUID user IDs, or chooses text IDs consistently across `app.user_id` and policies; the decision is recorded before any tenant table ships.
- [x] The Neon admin bootstrap script creates `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` without `BYPASSRLS`. Forced RLS blocks cross-tenant access for `app_user`, while the `fn_owner` policies let security-definer functions work. This is tested from a laptop, without Render.
- [x] A pg-boss heartbeat and scheduled job run; measure whether the dispatch interval keeps Neon awake and choose an interval or strategy. The `pgboss` schema is installed by the migrator, the runtime role has DML only, and the spike records the version option that skips pg-boss's own migration.
- [x] The app connects with the pooled database URL; the migrator and pg-boss use the direct URL. A test runs a tenant transaction on a pooled connection and asserts `app.workspace_id` is empty immediately after the transaction ends, proving transaction-local context does not leak between requests.
- [x] The spike records the peer address and forwarded headers NestJS sees behind the Next.js `/v1/*` rewrite so ticket 04's trusted-proxy tests can assert the real hop chain.
- [x] The alpha deploy is triggered by GitHub Actions after migrations succeed; Render auto-deploy on push is disabled. The migrator URL is stored only as a GitHub Actions secret, never in Render's runtime environment. Render free does not support pre-deploy migration commands, so migrations never run as a Render pre-deploy step.
- [x] The decision table records the fallback for each failure: auth mount fails in NestJS → run auth in Next.js and keep the session-endpoint boundary; rewrite or supervisor fails → two services; Neon roles or `fn_owner` policies cannot be made to work without `BYPASSRLS` → switch the Postgres host before feature work; Render free cannot run the migration step → GitHub Actions migration before the deploy hook, which is now the primary path.
- [x] No product features are built here; the outbox dispatcher begins in ticket 05.

## Implementation notes (2026-10-31)

- Timebox adapted to a single-session spike; the two-day pacing does not map to agent execution. Decision record: `docs/adr/0003-topology-spike.md` (GO on single-service topology: supervisor + Next `/v1/*` rewrite + Better Auth in NestJS + pg-boss).
- Better Auth pinned with UUIDv7 user IDs (`generateId`), proven by a sign-up/session round-trip test through the mounted handler.
- pg-boss: direct URL, `migrate:false`/`createSchema:false` (schema DDL installed by the migrator; PG17 `IF NOT EXISTS` ACL finding recorded), 30s dispatch cron so pooled Neon is not kept awake — interval configurable.
- Neon/Render/email-provider items are implemented as code + GitHub Actions workflow (`deploy.yml`) and documented runbook steps; live verification requires credentials (tracked in ticket 12).
- Trusted proxy hop chain (ticket 04 dependency): supervisor/rewrite tests assert the NestJS-visible peer path locally; Render/Cloudflare header assumptions remain a ticket-04 test concern.
