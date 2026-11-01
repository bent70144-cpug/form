# Runbook — Deploy M0 to the alpha (Neon + Render + GitHub Actions)

> **Runbook — live steps require Neon/Render/email credentials.** Everything
> below is implemented as code (workflows, bootstrap/migrate CLIs, email
> adapters); the steps marked _requires credentials_ cannot be executed
> without the real accounts and are tracked in
> [issues/12-deploy-smoke.md](../issues/12-deploy-smoke.md).

## Pipeline overview

Deploy order is load-bearing: **migrations run first, then code ships**.

1. Push to `main` triggers [deploy.yml](../.github/workflows/deploy.yml)
   (also `workflow_dispatch`; concurrency group `deploy-production`, never
   cancelled mid-run).
2. The `migrate` job installs dependencies and runs `pnpm db:migrate` with the
   `MIGRATOR_DATABASE_URL` GitHub secret — migrations apply as the `migrator`
   role over the direct Neon URL.
3. The `deploy` job (needs `migrate`) POSTs to `RENDER_DEPLOY_HOOK_URL` to
   trigger the Render deploy.

Constraints baked into this design:

- **Render auto-deploy on push must be disabled** in the Render dashboard
  (Settings → Build & Deploy → Auto-Deploy: off), so new code can never start
  before the schema exists.
- Render's free tier has **no pre-deploy migration command**; GitHub Actions
  migration-before-deploy is the primary path (ADR 0003).
- The migrator URL exists **only** as a GitHub Actions secret — it never
  appears in Render's runtime environment.
- [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs lint,
  typecheck, and tests on every branch (database tests use the embedded
  Postgres substitute, ADR 0001) before anything reaches `main`.

## One-time provisioning — requires credentials

1. **Neon project** — create it; note both URLs (pooled and direct, see below).
2. **Admin bootstrap** — from a machine that can reach Neon, run
   `pnpm db:bootstrap` with:

   - `ADMIN_DATABASE_URL` — admin connection to the Neon database;
   - `MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `WORKER_PASSWORD` — passwords
     for the least-privilege roles (min 8 chars each; env vars only, they
     never appear in migration files).

   This creates the `app`, `auth`, and `pgboss` schemas (owned by `migrator`)
   and the `migrator`, `app_user`, `worker_user`, and `NOLOGIN fn_owner`
   roles.

3. **Render web service** — point it at the repo, then **disable auto-deploy
   on push** and copy the deploy hook URL.
4. **Email provider** — create the account (Resend adapter is wired; see
   below) and store the API key.

## Required secrets

| Where          | Secret                                           | Value                                                                                                                          |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions | `MIGRATOR_DATABASE_URL`                          | **Direct** (non-pooled) Neon URL for the `migrator` role. Not the pooled `?pgbouncer=true` URL.                                |
| GitHub Actions | `RENDER_DEPLOY_HOOK_URL`                         | Deploy hook URL of the Render service.                                                                                         |
| Render         | `DATABASE_URL`                                   | **Pooled** Neon URL for `app_user` (request path).                                                                             |
| Render         | `WORKER_DATABASE_URL`                            | **Direct** Neon URL for `worker_user` (pg-boss needs session-scoped features; transaction-mode pooling breaks them).           |
| Render         | `BETTER_AUTH_SECRET`                             | Auth secret (API child only — never the web child).                                                                            |
| Render         | `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | Email sending, see below.                                                                                                      |
| Render         | `APP_ORIGIN`, `LOG_LEVEL`, `TRUSTED_PROXY_COUNT` | Public origin; log level; trusted proxy hops (ADR 0004 — the default of 1 matches the Render platform edge; keep it explicit). |

Neon pooled vs direct split (ADR 0003): the **app uses the pooled URL**;
the **migrator and pg-boss use the direct URL**.

Render child-process environments are allowlisted by the supervisor
(`scripts/supervisor.mjs`): web receives only `PORT`, `APP_ORIGIN`,
`API_INTERNAL_URL`/`API_INTERNAL_PORT`, `LOG_LEVEL` — never `DATABASE_URL`,
auth secrets, or the migrator URL (fail-closed check; tested in
`packages/config/test/supervisor.test.mjs`).

## Email provider configuration — requires credentials

- Verification and password-reset mail goes through the **HTTPS provider**
  (`EMAIL_PROVIDER=resend` with `RESEND_API_KEY`); production defaults to
  Resend when `NODE_ENV=production`. There is **no console adapter** — an
  unconfigured deployed environment fails the send loudly instead of leaking
  tokens into logs, and deployed logs must never contain verification tokens.
- The provider sandbox may deliver only to the account owner's address during
  development.
- **Before the first outside tester:** own and verify a sending domain with
  the provider (roughly $10/year — confirm current pricing). The
  `onrender.com` hostname cannot be verified as a sender domain.

## Smoke checklist (ticket 12 skeleton)

Run after the first deploy; every live step below **requires credentials**.
The full acceptance list is [issues/12-deploy-smoke.md](../issues/12-deploy-smoke.md).

- [ ] _requires Neon credentials_ — Admin bootstrap ran on Neon; schemas and
      the four roles exist; no role password appears in a migration file and
      the migrator password is absent from Render's runtime environment.
- [ ] _requires GitHub secrets_ — Deploy pipeline order verified: GitHub
      Actions migrations (as `migrator`) completed **before** the Render hook
      fired; Render auto-deploy on push is disabled.
- [ ] _requires email credentials_ — Live signup delivers a verification
      email through the HTTPS provider (no Mailpit); password reset likewise;
      no verification token appears in the logs.
- [ ] Live loop on the alpha: sign up → verify → bootstrap workspace → create
      form → publish at `/f/{slug}` → submit as an unauthenticated respondent
      → review the submission in the dashboard inbox.
- [ ] Cold-start behavior measured, including the authenticated SSR session
      hop (free-tier spin-up is expected; do not encode it into domain code).
- [ ] Supervisor environment allowlist assertion passes on the deployed
      build: the Next process environment contains no `DATABASE_URL`, auth
      secret, or migrator URL (process-level separation only; real service
      isolation arrives at the beta split).
- [ ] Health endpoint reports process liveness and database reachability
      without exposing tenant data.
- [ ] Logs contain no tenant data, no cookies/tokens/authorization headers,
      and no secrets.
- [ ] Ticket-04 auth hardening present in the deployed build: Origin check on
      cookie-authenticated mutations and the concrete rate limits (429
      `rate_limited` with `Retry-After`).
