# form

A pnpm + Turborepo TypeScript monorepo for a hosted workspace of
conversational forms. Three entrypoints — `apps/web` (public origin),
`apps/api` (REST API under `/v1`), `apps/worker` (queue consumer) — plus
shared packages: `contracts`, `form-schema`, `i18n`, `ui`, `queue`, `auth`,
`config` (env/logger/lint guardrails) and `database` (the only
request-path package that touches Postgres).

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | install all workspace dependencies |
| `pnpm dev` | one command that starts everything (see below) |
| `pnpm -w lint` / `pnpm -w typecheck` / `pnpm -w test` | workspace-wide quality gates (CI runs all three) |
| `pnpm db:start` / `pnpm db:stop` | boot/stop the local PostgreSQL 17 cluster on `127.0.0.1:5433` |
| `pnpm db:bootstrap` | one-time admin bootstrap (schemas `app`, `auth`, `pgboss` + least-privilege roles) |
| `pnpm db:migrate` | run SQL migrations as the `migrator` role |

## Local development without Docker

This environment has no Docker daemon. The spec allows a documented
substitute (see `docs/adr/0001-local-infra-substitutes.md`); the defaults are:

- **PostgreSQL 17 (embedded, real binaries)** via the `embedded-postgres`
  npm package instead of the `postgres` Docker image. It listens on
  `127.0.0.1:5433` with superuser `postgres` (the initdb superuser plays the
  one-time **admin**; all runtime traffic uses the real least-privilege roles
  `migrator`, `app_user`, `worker_user` — RLS guarantees are never weakened).
  Start it manually with `pnpm db:start`, or let `pnpm dev` do it.
- **One-time admin bootstrap**, then migrations:
  ```sh
  pnpm db:start        # embedded PostgreSQL 17 on :5433 (superuser postgres)
  pnpm db:bootstrap    # creates app/auth/pgboss schemas + roles (idempotent)
  pnpm db:migrate      # runs migrations as the migrator role (idempotent)
  ```
- **Mail sink** instead of Mailpit: `node scripts/mail-sink.mjs` runs a
  dependency-free SMTP server on `127.0.0.1:1025` with a JSON mailbox API at
  `GET http://127.0.0.1:8025/dev/mailbox` (`DELETE` clears it). It is the
  same port pair Mailpit uses natively; `docker-compose.yml` still ships
  Mailpit (`5434:8025`) for Docker-capable machines.
- **One command for everything:** `pnpm dev` runs `scripts/supervisor.mjs`,
  which boots the embedded Postgres (if nothing is on 5433), runs the
  idempotent bootstrap + migrations, starts the mail sink, then starts
  `web` (:3000), `api` (:4000) and `worker` — each child process gets an
  **explicit allowlisted environment** (`buildChildEnv` in
  `scripts/supervisor.mjs`). The web process receives NO `DATABASE_URL` and
  no auth secrets; a forbidden key aborts the spawn (tested in
  `packages/config/test/supervisor.test.mjs`), and the web import boundary is
  additionally enforced by ESLint and `apps/web/scripts/check-imports.mjs`.
  The worker registers a `heartbeat` job and logs a heartbeat on
  `HEARTBEAT_INTERVAL_MS` (default 10s).

Ports at a glance: Postgres `5433` · web `3000` · API `4000` · SMTP `1025` ·
mailbox API `8025`.

## Architecture notes

- `apps/web` proxies same-origin `/v1/*` to the internal API — the seam the
  Next.js `rewrites()` configuration replaces when the Next.js App Router is
  wired (topology spike, ticket 02).
- API errors are RFC 9457 Problem Details with stable codes from
  `@form/contracts`; user-facing strings come from `@form/i18n` keys.
- The OpenAPI document is generated from the Zod contracts and served at
  `/v1/openapi.json` (snapshot-tested).
- The `JobQueue` port (enqueue / schedule / worker registration / start /
  stop / `isStarted`) is implemented by an in-memory adapter in M0; the
  pg-boss adapter lands with tickets 02/05 against a DIRECT Postgres URL.
