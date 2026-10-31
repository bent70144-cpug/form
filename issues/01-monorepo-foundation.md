# 01: Monorepo foundation and local health

**Spec:** `../spec.md`

**What to build:** A runnable monorepo foundation and a health path from browser to API to Postgres, with the local development environment, one-time admin bootstrap, and tenant-safe database roles in place. No product auth or forms yet.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Docker is installed and `docker compose` can start Postgres and Mailpit; if Docker cannot be installed, a documented substitute is in place and used consistently.
- [ ] The pnpm + Turborepo workspace contains web, API, and worker entrypoints, shared config packages, and lint/typecheck/test scripts. It includes the contracts, form-schema, i18n, UI, queue, auth, and config packages.
- [ ] A one-time admin bootstrap script, run with admin credentials and not as a migration, creates the `app`, `auth`, and `pgboss` schemas and the `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` roles. All runtime roles lack `BYPASSRLS`; role passwords come from environment variables and never appear in migration files. The admin grants `fn_owner` to `migrator` with `SET` so migrations can assign function ownership.
- [ ] Migrations run as `migrator` after the admin bootstrap; they create tables, RLS policies, functions, and grants. The pg-boss schema DDL is installed by the migrator, and the runtime role gets DML only; the spike confirms the pg-boss version can skip its own migration.
- [ ] The transaction wrapper sets `app.workspace_id` and `app.user_id` transaction-locally and refuses tenant queries outside a transaction.
- [ ] `GET /v1/health` reports liveness and database reachability and is reachable through the Next.js `/v1/*` rewrite.
- [ ] One documented command starts web, API, and worker; the worker logs a heartbeat.
- [ ] CI runs install, lint, typecheck, and tests.
- [ ] A structured logger redacts cookies, auth tokens, and authorization headers; environment configuration is Zod-validated and fails at startup on missing or invalid values.
- [ ] The contracts package owns Zod request/response schemas and OpenAPI generation; an RFC 9457 Problem Details filter produces stable error bodies; `/v1/openapi.json` has a snapshot test.
- [ ] The i18n package is scaffolded with an English message catalog and typed key helpers; UI strings and API error messages are looked up by key rather than hardcoded.
- [ ] The web build and lint fail if the web app imports the database package or the server auth entrypoint; CI checks the web environment definition and the supervisor's child environment allowlist for database credentials and auth secrets.
- [ ] No product authentication, forms, or submissions are implemented in this slice.
