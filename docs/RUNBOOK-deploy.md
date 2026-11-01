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
  instead of leaking tokens into logs. Adapter selection is env-driven
  (`packages/auth/src/server/email/resolve.ts`): `mail_sink` is the
  dev/test default only (`NODE_ENV !== "production"`); production defaults
  to `resend` (`packages/auth/test/auth.test.ts` pins the matrix).
- **[REQUIRES CREDENTIALS]** Provider setup, in order:
  1. Create the provider account and generate an API key
     (sender identity, server-side only — it must reach only the API child;
     the supervisor allowlist already drops it from web/worker).
  2. During development the provider sandbox may deliver **only to the
     account owner's address** — sign up with the owner's address, receive
     the verification email, and confirm no verification token appears in
     the Render logs.
  3. **Before the first outside tester**: own and verify a sending domain
     with the provider (roughly $10/year — confirm current pricing; add the
     provider's DNS records at the domain registrar, wait for verification).
     The `onrender.com` hostname **cannot** be verified as a sender domain —
     without a verified domain, outside testers never receive mail.
  4. Set `EMAIL_FROM` to an address on the verified domain, e.g.
     `Form <noreply@your-domain.com>`.
- Also complete a password reset over the live email path once (single-use
  token, one-hour expiry, all sessions revoked on completion).

## 4. Cold-start measurement — [REQUIRES CREDENTIALS]

The Render free tier spins the service down; measure, don't guess (record the
numbers in the ticket). A dedicated script times all four render paths over
the live origin (no dependencies, works from any machine that can reach the
alpha):

```sh
pnpm measure:cold-start https://<alpha> \
  --slug <published-slug> \
  --cookie "better-auth.session_token=<copy from browser devtools>" \
  --runs 3 --json cold-start.json
```

(`--cookie` may also be passed as the `FORM_SESSION_COOKIE` env var. The
cookie value is a live session credential — keep it out of the ticket and out
of any committed file; only timings get recorded.)

The script measures, per target, a "cold" first run and warm medians:

1. `GET /v1/health` — API liveness + the live `SELECT 1` DB probe.
2. `GET /` — unauthenticated Next SSR.
3. `GET /f/<slug>` — the unauthenticated public SSR hop (Next server
   component → internal API security-definer read).
4. `GET /dashboard` — the **authenticated SSR session hop** (middleware
   cookie check → SSR session read → internal API with the forwarded
   cookie). Requires `--cookie`; the script skips it with a warning
   otherwise.

Manual equivalents (browser devtools network waterfall for the dashboard):

1. `time curl -s -o /dev/null -w "%{http_code} %{time_total}\n" https://<alpha>/v1/health`
2. `time curl -s -o /dev/null -w "%{http_code} %{time_total}\n" https://<alpha>/f/<slug>`

Interpretation:

- Run the script twice back-to-back; run 1 of the first invocation includes
  free-tier spin-up if the service was idle (cross-check Render Metrics →
  instance start events).
- The `/dashboard` hop minus `/v1/health` is the authenticated SSR session
  cost; the `/f/<slug>` hop minus `/v1/health` is the public SSR hop cost.
- Free-tier spin-up is expected and acceptable; do not encode it into domain
  code.

## 5. Live smoke checklist — [REQUIRES CREDENTIALS]

Run on the alpha URL after every deploy (the full acceptance list is
[issues/12-deploy-smoke.md](../issues/12-deploy-smoke.md)). Each step maps to
the automated coverage that already proves the same behavior locally/CI, so a
live failure localizes to deployment, not design:

| # | Live step on the alpha                                                     | Already proven by (automated)                                                                                                                                                                                                                     |
| - | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `GET /v1/health` → 200 `{"status":"ok","db":true}`                          | `apps/api/test/health.test.ts` (live `SELECT 1` probe, no-leak on failure), `apps/web/test/web.test.ts` (`/v1/*` rewrite proxy), `packages/contracts` (response schema), smoke-local CI step 1                                                    |
| 2 | Sign up with a real address → verification email arrives → link verifies    | `apps/api/test/auth-core.test.ts` + `auth-roundtrip.test.ts` (real HTTP loop over the mail sink), `packages/auth/test/auth.test.ts` (HTTPS adapter, i18n copy), smoke-local steps 2–4; **live-only risk**: provider/domain configuration (§3)     |
| 3 | Sign in → dashboard loads with a session                                   | smoke-local step 4; `apps/web/test/auth-ui.test.ts`                                                                                                                                                                                               |
| 4 | `POST /v1/workspaces/bootstrap` (idempotent personal workspace)             | `apps/api/test/workspaces.test.ts`, `apps/web/test/bootstrap-workspace.test.ts`; smoke-local step 5                                                                                                                                               |
| 5 | Create a form, save a valid draft (welcome + required short_text + ending)  | `apps/api/test/forms.test.ts` + `forms-draft.test.ts` (409 `draft_conflict`, 422s); smoke-local steps 6–7                                                                                                                                          |
| 6 | Publish → `/f/{slug}` answers unauthenticated, `Cache-Control: no-store`    | `apps/api/test/publish.test.ts` + `public.test.ts`; smoke-local steps 8–9                                                                                                                                                                         |
| 7 | Public session → submit → receipt (missing required answer → 422)           | `apps/api/test/public-session.test.ts` + `public-submissions.test.ts`; smoke-local steps 10–11                                                                                                                                                    |
| 8 | Review the submission in the dashboard inbox                                | ticket-11 suites + Playwright path once merged; on this branch the durable-retrieval proof is smoke-local step 12 (idempotent replay returns the SAME submission id)                                                                              |
| 9 | Unpublish → closed message; republish → works again, new version            | `apps/api/test/publish.test.ts` (version increments, closed-form behavior)                                                                                                                                                                        |

Also on every live run:

- [ ] Health body is exactly `{"status":"ok","db":true}` — the 200 is process
      liveness, `db` is a **live** `SELECT 1` probe on the pooled app_user
      connection (`apps/api/src/health.controller.ts`). `"db":false` (still
      200) means the database is unreachable — check the Neon pooled URL /
      role password first. The body never carries error text (pg errors can
      embed connection strings).
- [ ] Supervisor allowlist on the deployed build: the Next process env has no
      `DATABASE_URL`, auth secret, or migrator URL (proven in CI by
      `packages/config/test/supervisor.test.mjs` and the web-process guard
      `apps/web/src/lib/env.ts` — it refuses startup on any forbidden key; on
      Render, spot-check via the service shell `env | sort` inside the web
      child if needed).
- [ ] Logs contain no tenant data, no cookies/tokens/authorization headers,
      and no verification tokens. Mechanism: pino `redact` paths in
      `packages/config/src/logger.ts`, pinned by
      `packages/config/test/logger.test.ts`; the Resend adapter never echoes
      the message body on failure (`packages/auth/test/auth.test.ts`). On the
      live alpha, scan the first deploy's logs once for the signed-up
      address, the form title, and the submission answer — none should appear.
- [ ] Cold-start numbers recorded (section 4).
- [ ] Ticket-04 auth hardening present — run the verification mapping in
      section 6.

## 6. Ticket-04 auth hardening on the deployed build — [REQUIRES CREDENTIALS]

The hardening ships in the same build as everything else (CI runs the suites
below on every branch), so "present in the deployed build" is primarily a
spot-check that the production env (e.g. `TRUSTED_PROXY_COUNT`) is set
correctly. Exact commands:

1. **Origin guard** — a state-changing request without the browser Origin
   must get `403` with `"code":"origin_mismatch"`:

   ```sh
   curl -si -X POST https://<alpha>/v1/auth/sign-in/email \
     -H 'content-type: application/json' \
     --data '{"email":"nobody@example.com","password":"not-the-password"}' \
     | head -n 1
   ```

   → `HTTP/1.1 403 Forbidden`. Code: `apps/api/src/common/origin-guard.ts`;
   tests: `apps/api/test/auth-core.test.ts` (evil origins 403, safe methods
   exempt).

2. **Rate limits** — hammering sign-in from one address must eventually give
   `429` with an RFC 9457 body (`rate_limited`) and a `Retry-After` header:

   ```sh
   for i in $(seq 1 12); do
     curl -s -o /dev/null -w "%{http_code} " -X POST https://<alpha>/v1/auth/sign-in/email \
       -H 'content-type: application/json' -H "origin: https://<alpha>" \
       --data '{"email":"nobody@example.com","password":"not-the-password"}'
   done; echo
   ```

   → ten `401`s (bad credentials, origin accepted) then `429`s for requests
   11–12. Limits (the single source of truth is
   `apps/api/src/common/rate-limit/limits.ts`): signup 5/h/IP; sign-in
   10/15min per IP **and** per email; reset 3/h per email + 10/h per IP;
   `GET /v1/auth/session` 120/min/IP; public session 30/h per IP and per
   form. Tests: `apps/api/test/auth-rate-limit.test.ts`,
   `rate-limit.test.ts`, `public-session.test.ts`.

3. **Trusted proxy handling** — on Render `TRUSTED_PROXY_COUNT=1` must be
   set (Render env, section 2): the rightmost `X-Forwarded-For` entry is the
   edge-attested client IP and client-supplied entries cannot change the
   derived address the limiter keys on. Code:
   `apps/api/src/common/trusted-ip/`; tests: `trusted-ip.test.ts` and
   `trusted-ip-rewrite.test.ts` (drives the REAL browser → Next `/v1/*`
   rewrite → Nest hop with both the local `0` and the Render `1`
   configuration; spoofed headers never change the derived IP).

4. **Password policy** — sign-up with a 11-char password must fail
   validation (`422`), 12–128 accepted. Code: `packages/auth/src/password.ts`
   (`PASSWORD_LIMITS = { min: 12, max: 128 }`); tests:
   `packages/auth/test/auth.test.ts` + the auth round-trip suite.

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
