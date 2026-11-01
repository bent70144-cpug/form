# Runbook — Deploy M0 to the alpha (Neon + Render + GitHub Actions)

> **Live steps require Neon/Render/email credentials.** Everything below is
> implemented as code (workflows, bootstrap/migrate CLIs, email adapters,
> supervisor `--serve`, the local smoke); the steps marked **[REQUIRES
> CREDENTIALS]** cannot be executed without the real accounts and are tracked
> in [issues/12-deploy-smoke.md](../issues/12-deploy-smoke.md).
> Everything NOT marked that way is runnable locally right now.

## 0. Local smoke BEFORE any deploy (no credentials needed)

The final deployment milestone is a smoke test, not the first deploy. The
automated smoke boots the whole walking skeleton on one machine and drives the
real loop over HTTP:

```sh
pnpm install
pnpm smoke:alpha
```

`scripts/smoke-alpha.mjs` starts `scripts/supervisor.mjs --dev` (embedded
Postgres on 5433, idempotent admin bootstrap + migrations, mail sink, API,
worker, web), then asserts, in order:

1. `GET /v1/health` through the Next.js `/v1/*` rewrite (liveness + DB reach)
2. signup (`POST /v1/auth/sign-up/email`, no session before verification)
3. verification email arrives in the mail sink; the verify link redeems
4. sign-in → `GET /v1/auth/session` reports `emailVerified: true`
5. `POST /v1/workspaces/bootstrap` (idempotent, personal workspace, owner)
6. `POST /v1/forms` creates the form
7. `PUT /v1/forms/{id}/draft` saves VALID blocks (welcome + required
   short_text + ending) and a stale `draftVersion` gets `409 draft_conflict`
8. `POST /v1/forms/{id}/publish` → 10-char slug
9. `GET /v1/public/forms/{slug}` unauthenticated, `Cache-Control: no-store`
10. `POST /v1/public/forms/{slug}/sessions` → 24 h pinned cookie-less session
11. `POST /v1/public/submissions` → receipt; missing required answer → 422
12. the submission is durably retrievable (dashboard inbox endpoint when
    merged; otherwise the idempotent replay returns the SAME submission id)

It prints PASS/FAIL per step and exits non-zero on the first failure. CI runs
it on every push to `main` and `integration/m0` (workflow job `smoke-local`
in [deploy.yml](../.github/workflows/deploy.yml)).

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
4. The `smoke-local` job runs the local alpha smoke (section 0) on every push
   to `main`/`integration/m0` — the walking skeleton proven in CI. **The
   RENDER smoke (against the live alpha URL) is manual** — see section 5.

Constraints baked into this design:

- **Render auto-deploy on push must be disabled** in the Render dashboard
  (Settings → Build & Deploy → Auto-Deploy: off), so new code can never start
  before the schema exists.
- Render's free tier has **no pre-deploy migration command**; GitHub Actions
  migration-before-deploy is the primary path (ADR 0003).
- The migrator URL exists **only** as a GitHub Actions secret — it never
  appears in Render's runtime environment (asserted by
  `packages/config/test/supervisor.test.mjs`: no child process ever receives
  `MIGRATOR_DATABASE_URL` or `ADMIN_DATABASE_URL`).
- [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs lint,
  typecheck, and tests on every branch (database tests use the embedded
  Postgres substitute, ADR 0001) before anything reaches `main`.

## 1. One-time provisioning — [REQUIRES CREDENTIALS]

### 1a. Neon project

1. **[REQUIRES CREDENTIALS]** Create the Neon project; note the **direct** and
   the **pooled** connection strings (ADR 0003: app → pooled, migrator and
   pg-boss → direct). Create three role passwords (min 8 chars each, store in
   the owner's password manager — they are env vars only and never appear in
   migration files).
2. **[REQUIRES CREDENTIALS]** Run the one-time admin bootstrap from a machine
   that can reach Neon (locally: the initdb superuser plays the admin; on
   Neon: the project owner connection). Script:
   `packages/database/src/cli/bootstrap.ts` via `pnpm db:bootstrap`:

   ```sh
   ADMIN_DATABASE_URL="postgres://<owner>:<pw>@<neon-host>/<db>" \
   MIGRATOR_PASSWORD="…" \
   APP_USER_PASSWORD="…" \
   WORKER_PASSWORD="…" \
   pnpm db:bootstrap
   ```

   This creates the `app`, `auth`, and `pgboss` schemas (owned by `migrator`)
   and the `migrator`, `app_user`, `worker_user`, and `NOLOGIN fn_owner`
   roles. No role password appears in a migration file. **One-time only** —
   never part of the migration path or the deploy pipeline.
3. **[REQUIRES CREDENTIALS]** Verify with the least-privilege URLs that the
   roles behave (connect as `app_user` → no DDL, as `migrator` → no tenant
   rows). The database package's RLS/catalog tests already prove the shape.

### 1b. GitHub Actions secrets — [REQUIRES CREDENTIALS]

| Secret                  | Value                                                                 | Holder           |
| ----------------------- | --------------------------------------------------------------------- | ---------------- |
| `MIGRATOR_DATABASE_URL` | **Direct** Neon URL for the `migrator` role (NOT the pooled `?pgbouncer=true` URL) | GitHub Actions only — never Render, never a role password in a migration file |
| `RENDER_DEPLOY_HOOK_URL`| Deploy hook URL of the Render service (Settings → Deploy Hooks)       | GitHub Actions only |

1. **[REQUIRES CREDENTIALS]** Set both secrets in the repository settings.
2. **[REQUIRES CREDENTIALS]** Run the `deploy` workflow once with
   `workflow_dispatch` (or push to `main`) and watch the `migrate` job apply
   the schema — **before** the Render hook ever fires. If migrations fail, the
   deploy job never runs (the hook is `needs: migrate`).
3. **[REQUIRES CREDENTIALS]** Confirm in Render that auto-deploy on push is
   **off** — new code cannot start before the schema exists.

## 2. Render web service — [REQUIRES CREDENTIALS]

Create the service (Build & Deploy):

| Setting       | Value                                        |
| ------------- | -------------------------------------------- |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Start command | `node scripts/supervisor.mjs --serve`        |
| Auto-Deploy   | **off** (deploys happen only via the hook)   |

`--serve` spawns the built `next start`, the NestJS API, and the inline worker
with the SAME per-child allowlists as dev mode (fail-closed web check). Set
ONLY the variables below — everything else is dropped by the allowlist, and
any `*PASSWORD*`/`*SECRET*`/`*TOKEN*`/`*API_KEY*`/`*DATABASE_URL*`/`*MIGRATOR*`/`*ADMIN*`
key that somehow reached the web child would abort the boot:

| Variable (Render env) | Child        | Meaning                                                                     |
| --------------------- | ------------ | --------------------------------------------------------------------------- |
| `DATABASE_URL`        | api          | **Pooled** Neon URL as `app_user` (request path)                            |
| `WORKER_DATABASE_URL` | worker       | **Direct** Neon URL as `worker_user` (pg-boss needs session-scoped features) |
| `BETTER_AUTH_SECRET`  | api only     | Auth secret (min 16 chars) — never the web child                            |
| `APP_ORIGIN`          | web + api    | The public origin, e.g. `https://form-alpha.onrender.com` (Origin check)    |
| `EMAIL_PROVIDER`      | api only     | `resend` (production default; unconfigured → the send fails loudly)         |
| `RESEND_API_KEY`      | api only     | Email provider API key — server-side only                                   |
| `EMAIL_FROM`          | api only     | Verified sender, e.g. `Form <noreply@your-domain.com>`                      |
| `TRUSTED_PROXY_COUNT` | api only     | `1` behind the Render platform edge (ADR 0004; explicit beats implicit)     |
| `IP_HASH_SECRET`      | api only     | HMAC key for stored session `ip_hash` (min 16 chars; optional, derived from the auth secret when unset) |
| `FORM_SUBMISSION_CAP` | api only     | Per-form submission cap (default 1000)                                      |
| `LOG_LEVEL`           | all children | `info` in production                                                        |

`PORT` is provided by Render and honored by the supervisor; the API listens
on `API_PORT` (default 4000) on localhost only. **The migrator URL is not set
anywhere in Render** — not as an env var, not in a build command.

## 3. Email provider — [REQUIRES CREDENTIALS]

- Verification and password-reset mail goes through the **HTTPS provider**
  (`EMAIL_PROVIDER=resend` with `RESEND_API_KEY`); there is **no console
  adapter** — an unconfigured deployed environment fails the send loudly
  instead of leaking tokens into logs.
- **[REQUIRES CREDENTIALS]** The provider sandbox may deliver only to the
  account owner's address during development. Verify: sign up with the
  owner's address, receive the verification email, confirm no verification
  token appears in the Render logs.
- **Before the first outside tester** **[REQUIRES CREDENTIALS]**: own and
  verify a sending domain with the provider (roughly $10/year — confirm
  current pricing; add the provider's DNS records, wait for verification).
  The `onrender.com` hostname **cannot** be verified as a sender domain —
  without a verified domain, outside testers never receive mail.
- Also complete a password reset over the live email path once (single-use
  token, one-hour expiry, all sessions revoked on completion).

## 4. Cold-start measurement — [REQUIRES CREDENTIALS]

The Render free tier spins the service down; measure, don't guess (record the
numbers in the ticket):

1. `time curl -s -o /dev/null -w "%{http_code} %{time_total}\n" https://<alpha>/v1/health`
   — cold vs. warm (run twice; the first includes process spin-up).
2. `time curl -s -o /dev/null -w "%{http_code} %{time_total}\n" https://<alpha>/f/<slug>`
   — the unauthenticated SSR page (Next → internal API hop).
3. Sign in and load `https://<alpha>/dashboard` — the **authenticated SSR
   session hop** (Next server component → internal API with the forwarded
   cookie) — measure with the browser devtools network waterfall.
4. Free-tier spin-up is expected and acceptable; do not encode it into domain
   code.

## 5. Live smoke checklist — [REQUIRES CREDENTIALS]

Run on the alpha URL after every deploy (the full acceptance list is
[issues/12-deploy-smoke.md](../issues/12-deploy-smoke.md)):

- [ ] `GET https://<alpha>/v1/health` → 200 `{"status":"ok","db":"ok"}` — no
      tenant data in the body.
- [ ] Live loop: sign up (outside tester's address once the domain is
      verified) → verify via the REAL email → bootstrap workspace → create a
      form → save a draft with valid blocks → publish at `/f/{slug}` → open
      the link in a private window → submit as an unauthenticated respondent →
      review the submission in the dashboard inbox.
- [ ] Unpublish → the public form shows the closed message; republish → the
      link works again with a new version number.
- [ ] Ticket-04 auth hardening present in the deployed build: a cookie-less
      mutation gets 403 `origin_mismatch`; hammering sign-up gets 429
      `rate_limited` with `Retry-After`.
- [ ] Supervisor allowlist on the deployed build: the Next process env has no
      `DATABASE_URL`, auth secret, or migrator URL (proven in CI by
      `packages/config/test/supervisor.test.mjs`; on Render, spot-check via
      the service shell `env | sort` inside the web child if needed).
- [ ] Logs contain no tenant data, no cookies/tokens/authorization headers,
      and no verification tokens (the structured-logger redaction tests in
      `packages/config` and `apps/api` prove the mechanism; on the live alpha,
      scan the first deploy's logs once for the signed-up address, the form
      title, and the submission answer — none should appear).
- [ ] Cold-start numbers recorded (section 4).

## Required secrets (summary)

| Where          | Secret                                           | Value                                                                                                                          |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions | `MIGRATOR_DATABASE_URL`                          | **Direct** (non-pooled) Neon URL for the `migrator` role. Not the pooled `?pgbouncer=true` URL.                                |
| GitHub Actions | `RENDER_DEPLOY_HOOK_URL`                         | Deploy hook URL of the Render service.                                                                                         |
| Render         | `DATABASE_URL`                                   | **Pooled** Neon URL for `app_user` (request path).                                                                             |
| Render         | `WORKER_DATABASE_URL`                            | **Direct** Neon URL for `worker_user` (pg-boss needs session-scoped features; transaction-mode pooling breaks them).           |
| Render         | `BETTER_AUTH_SECRET`                             | Auth secret (API child only — never the web child).                                                                            |
| Render         | `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | Email sending, see section 3.                                                                                                  |
| Render         | `APP_ORIGIN`, `LOG_LEVEL`, `TRUSTED_PROXY_COUNT` | Public origin; log level; trusted proxy hops (ADR 0004 — the default of 1 matches the Render platform edge; keep it explicit). |

Neon pooled vs direct split (ADR 0003): the **app uses the pooled URL**;
the **migrator and pg-boss use the direct URL**.

Render child-process environments are allowlisted by the supervisor
(`scripts/supervisor.mjs`): web receives only `PORT`, `APP_ORIGIN`,
`API_INTERNAL_URL`/`API_INTERNAL_PORT`, `LOG_LEVEL` — never `DATABASE_URL`,
auth secrets, or the migrator URL (fail-closed check; tested in
`packages/config/test/supervisor.test.mjs`).
