# ADR 0001 — Local infrastructure substitutes (no Docker)

**Status:** Accepted · **Ticket:** 01 · **Date:** 2026-10-31

## Context

The spec's foundation slice calls for Postgres and Mailpit via Docker Compose.
The current development environment has no Docker daemon and no root access,
and the spec explicitly allows "installing Docker or documenting and using an
equivalent Postgres/Mailpit setup" (spec, Further Notes + Deployment).

## Decision

1. **Postgres → embedded real PostgreSQL.** The `embedded-postgres` npm
   package (real PostgreSQL 17 binaries) boots a local cluster on
   `127.0.0.1:5433` (superuser `postgres`). It is started by `pnpm db:start`,
   by the dev supervisor, and automatically by the Vitest global setup.
   - The initdb superuser plays the **admin** for the one-time bootstrap only.
   - All application/test traffic uses the real least-privilege roles
     (`migrator`, `app_user`, `worker_user`, NOLOGIN `fn_owner`); no test is
     weakened to run as a superuser, so RLS/role guarantees remain provable.
2. **Mailpit → Node SMTP sink.** `scripts/mail-sink.mjs` is a dependency-free
   SMTP server (port 1025) with a JSON mailbox API (port 8025,
   `GET /dev/mailbox`). Tests and local dev read verification mail from it.
   `docker-compose.yml` (postgres + mailpit) is still committed for
   Docker-capable environments but is not the default path.
3. **Neon / Render / email provider** are not reachable from this environment.
   Everything they require is implemented as code, scripts, GitHub Actions
   workflow, and runbook documentation; live verification is a documented
   manual step requiring credentials (tracked in ticket 12).

## Consequences

- One command (`pnpm dev`) still starts the full stack locally.
- Tests exercise a genuine PostgreSQL 17 server, including forced RLS,
  security-definer functions, and role isolation.
- The role model is identical in local and deployed environments; only the
  connection strings and the admin differ (Neon admin vs. initdb superuser).
