# form

A hosted workspace where an agency can create a conversational form, publish
it at a shareable link, collect responses from unauthenticated respondents,
and review every submission in one place — with a hard guarantee that one
client's workspace can never see another's data. This repository is **M0, the
walking skeleton**: the thinnest end-to-end version that proves the
architecture, tenancy model, and deployment path before logic, themes,
payments, and integrations are built. See [spec.md](spec.md) for the full
requirements.

## Repository layout

pnpm + Turborepo TypeScript monorepo. Three entrypoints and nine shared
packages:

| Path                   | Package             | Purpose                                                                                                                                              |
| ---------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`             | `@form/web`         | Next.js App Router. Dashboard and public form pages on the public origin; proxies same-origin `/v1/*` to the API. No database access.                |
| `apps/api`             | `@form/api`         | NestJS REST API under `/v1`. Owns all request-path database access and mounts Better Auth at `/v1/auth/*`.                                           |
| `apps/worker`          | `@form/worker`      | Queue consumer: pg-boss heartbeat, outbox dispatch. Expired-session purge lands with ticket 10.                                                      |
| `packages/contracts`   | `@form/contracts`   | Zod request/response schemas, stable error codes, OpenAPI generation (served at `/v1/openapi.json`).                                                 |
| `packages/database`    | `@form/database`    | Drizzle schema, SQL migrations, RLS/bootstrap SQL, UUIDv7, pool and tenant-transaction wrapper. The only request-path package that touches Postgres. |
| `packages/form-schema` | `@form/form-schema` | Block union, schema validation, `schemaVersion` migrations. No Node or DOM dependencies.                                                             |
| `packages/auth`        | `@form/auth`        | Two entrypoints: `server` (DB-backed Better Auth, API-only) and `client` (shared types and typed session client for the web app).                    |
| `packages/queue`       | `@form/queue`       | `JobQueue` port with in-memory and pg-boss adapters; generic outbox dispatcher.                                                                      |
| `packages/i18n`        | `@form/i18n`        | Message catalogs (English in M0); user-facing strings are keys, never hardcoded.                                                                     |
| `packages/logic`       | `@form/logic`       | Boundary only in M0 — no visibility/jump/variable rules yet.                                                                                         |
| `packages/ui`          | `@form/ui`          | Shared React components.                                                                                                                             |
| `packages/config`      | `@form/config`      | Zod-validated env schemas, logger, and lint/style presets.                                                                                           |

Dependency rule: apps may depend on packages, packages may depend on packages,
no package may depend on an app. Two Postgres exceptions outside the database
package: the queue package owns the pg-boss adapter and the auth package owns
the `auth` schema.

## Quickstart

Prerequisites:

- Node.js 20 or newer (CI uses 22).
- pnpm 10 via corepack: `corepack enable && corepack prepare pnpm@10.34.9 --activate`
  (the `packageManager` field pins the exact version).

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `scripts/supervisor.mjs`, which boots the embedded Postgres on
`127.0.0.1:5433` if nothing is listening, runs the idempotent admin bootstrap
and migrations, starts the dev mail sink, then starts the children with
explicitly allowlisted environments:

| Process                             | Port        | Role                                                     |
| ----------------------------------- | ----------- | -------------------------------------------------------- |
| web (Next.js)                       | 3000        | Public origin; receives no `DATABASE_URL` and no secrets |
| api (NestJS)                        | 4000        | Internal; pooled `app_user` connection                   |
| worker                              | —           | Direct `worker_user` connection for pg-boss              |
| Postgres 17 (embedded)              | 5433        | `postgres` superuser plays the one-time admin only       |
| mail sink (SMTP / JSON mailbox API) | 1025 / 8025 | Verification mail in dev                                 |

In dev mode the supervisor fills every variable from
`scripts/supervisor.mjs` (`devDefaults`), so no `.env` file is required.
Sanity check: `curl -s http://localhost:3000/v1/health`.

### Manual database setup

Run the steps yourself (each is idempotent) with the environment variables
below — there is no `.env.example`; the schemas are defined in
`packages/config/src/env.ts`:

```sh
pnpm db:start      # embedded PostgreSQL 17 on 127.0.0.1:5433
pnpm db:bootstrap  # schemas app/auth/pgboss + roles; needs ADMIN_DATABASE_URL
pnpm db:migrate    # migrations as the migrator role; needs MIGRATOR_DATABASE_URL
pnpm db:stop
```

| Variable                                                    | Used by                 | Meaning                                                                                           |
| ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `ADMIN_DATABASE_URL`                                        | `db:bootstrap`          | Admin connection (locally the initdb superuser). One-time bootstrap only, never request handling. |
| `MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `WORKER_PASSWORD` | `db:bootstrap`          | Passwords for the least-privilege roles. Env vars only — they never appear in migration files.    |
| `MIGRATOR_DATABASE_URL`                                     | `db:migrate`, CI deploy | Direct (non-pooled) connection string for the `migrator` role.                                    |
| `DATABASE_URL`                                              | api child               | Pooled connection for `app_user` (request path).                                                  |
| `WORKER_DATABASE_URL`                                       | worker child            | Direct connection for `worker_user` (pg-boss needs session-scoped features).                      |
| `BETTER_AUTH_SECRET`                                        | api child               | Auth secret; api child only, never the web child.                                                 |
| `APP_ORIGIN`                                                | web + api children      | Public origin, used for the Origin check.                                                         |
| `API_INTERNAL_URL`                                          | web child               | Internal API base URL for the `/v1/*` rewrite.                                                    |

## Quality gates

```sh
pnpm lint        # eslint, including the web import-boundary rules
pnpm typecheck   # tsc across all workspaces (turbo)
pnpm test        # turbo, --concurrency=1; database tests boot the embedded Postgres
```

## Local development without Docker

Docker is not required (or assumed). Per
[ADR 0001](docs/adr/0001-local-infra-substitutes.md):

- **Postgres → embedded real PostgreSQL 17** via the `embedded-postgres` npm
  package on `127.0.0.1:5433`. The initdb superuser (`postgres`) plays the
  one-time admin for `pnpm db:bootstrap`; all runtime traffic uses the real
  least-privilege roles `migrator`, `app_user`, and `worker_user`, so RLS
  guarantees are never weakened — locally, in tests, or on Neon.
- **Mailpit → Node SMTP sink**: `scripts/mail-sink.mjs` (SMTP on 1025, JSON
  mailbox API on 8025 at `GET /dev/mailbox`). `docker-compose.yml` still ships
  Postgres + Mailpit for Docker-capable machines, but it is not the default
  path.
- Neon/Render/email-provider steps are implemented as code, workflows, and
  [docs/RUNBOOK-deploy.md](docs/RUNBOOK-deploy.md); live verification requires
  credentials.

## Security architecture

Tenant isolation is enforced by Postgres, not only by application checks
(full requirements: [spec.md "Tenancy and authorization"](spec.md#tenancy-and-authorization)):

- **Forced RLS on every tenant table**, with policies that always carry both
  `USING` and `WITH CHECK` against the transaction-local `app.workspace_id`
  setting (`nullif` keeps an unset setting from erroring — it matches no rows).
- **Composite tenant foreign keys**: every tenant relationship references
  `UNIQUE (workspace_id, id)` on its parent, so a row can never point at
  another workspace's form, session, or version. The catalog guard test
  (`packages/database`) fails any deployed schema that misses either the
  policy shape or the composite keys.
- **Security-definer functions owned by `fn_owner`** — a `NOLOGIN` role with
  no `BYPASSRLS` — are the only widened access: workspace listing/creation,
  public form resolution, slug registration, session resolution, and the
  worker's expired-session purge.
- **No runtime role has `BYPASSRLS`** — `app_user`, `worker_user`, and
  `fn_owner` are all bound by forced RLS.
- **The web process never sees database credentials or auth secrets**: the
  supervisor passes an explicit allowlist to each child and refuses to spawn
  the web child if a forbidden key (`DATABASE_URL`, `*PASSWORD*`, `*SECRET*`,
  `*TOKEN*`, `*MIGRATOR*`, `*ADMIN*`) would be present; the Zod env schema and
  the ESLint import boundary are the second and third guardrails.

Further decisions live in the ADRs ([docs/adr/](docs/adr)): local
infrastructure substitutes (0001), UUID strategy (0002), the single-service
alpha topology spike (0003), rate limiting and trusted client-IP derivation
(0004), and the outbox dispatcher (0005).

## Deployment

The alpha deploys as a single Render web service backed by Neon Postgres.
GitHub Actions runs migrations as the `migrator` **before** triggering the
Render deploy hook; Render auto-deploy on push is disabled. The operational
checklist, required secrets, and the smoke test are in
[docs/RUNBOOK-deploy.md](docs/RUNBOOK-deploy.md); the workflows are
[.github/workflows/ci.yml](.github/workflows/ci.yml) and
[.github/workflows/deploy.yml](.github/workflows/deploy.yml).

## Documentation map

- [spec.md](spec.md) — M0 requirements (source of truth).
- [GLOSSARY.md](GLOSSARY.md) — domain terms as implemented.
- [docs/adr/](docs/adr) — architecture decision records.
- [docs/RUNBOOK-deploy.md](docs/RUNBOOK-deploy.md) — alpha deploy runbook.
- [issues/](issues) — ticket-by-ticket implementation records.
