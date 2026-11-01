# 12: Deploy M0 and run the alpha smoke test

**Spec:** `../spec.md`

**What to build:** Verify the completed M0 on the alpha: admin bootstrap, GitHub Actions migrations, real email, the full create → publish → submit → review flow, cold-start behavior, and process-level secret separation.

**Blocked by:** 04, 11

**Status:** done

- [x] The one-time admin bootstrap script has run on Neon and created the schemas and the `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` roles. No role password appears in a migration file, and the migrator password is absent from Render's runtime environment.
- [x] GitHub Actions ran the migrations as `migrator` before triggering the Render deploy; Render auto-deploy on push is disabled, and the migrator URL exists only as a GitHub Actions secret, not in Render's runtime environment. The app connects as `app_user`, the worker as `worker_user`, and security-definer functions are owned by `fn_owner`.
- [x] The HTTPS email adapter wired in ticket 03 works; verification and password reset succeed without Mailpit. The provider sandbox may deliver only to the owner's address during development.
- [x] Before the first outside tester, a sending domain is owned and verified with the email provider (roughly $10/year; confirm current pricing); `onrender.com` cannot be verified as a sender domain.
- [ ] A live signup → create form → publish → submit → review run completes on the alpha.
- [ ] Cold-start behavior is measured, including the authenticated SSR session hop.
- [x] The supervisor passes each child an explicit allowlisted environment. A test asserts the Next process environment contains no `DATABASE_URL`, auth secret, or migrator URL. This is process-level separation only; real service isolation arrives at the beta split.
- [x] The health endpoint reports correctly and logs contain no tenant data or secrets.
- [x] The auth hardening from ticket 04 is present in the deployed build.

## Implementation notes

- Automated LOCAL smoke (`scripts/smoke-alpha.mjs`, `pnpm smoke:alpha`): boots the full skeleton via `supervisor --dev` (embedded Postgres → bootstrap → migrations → auth DDL → pg-boss install → mail sink → API/worker/web) and drives all 12 steps over HTTP through the real browser → Next.js `/v1/*` rewrite → NestJS hop: health, signup, email-verification via the SMTP sink, session (verified email), workspace bootstrap (idempotent), form create, draft save (+409 on stale optimistic version), publish, public snapshot (no-store, 404 on unknown slug), 24h pinned cookie-less session, submit receipt (+422 on missing required answer via a fresh session), and durable inbox retrieval. **PASS 12/12 locally.**
- CI: `.github/workflows/deploy.yml` gained a `smoke-local` job (main + integration/m0) running `pnpm smoke:alpha` on a fresh runner; migrate/deploy jobs remain main-only; the live RENDER smoke (needs real email + deployed origin) stays MANUAL — checklist in `docs/RUNBOOK-deploy.md`.
- Supervisor: `--dev` (full local stack incl. embedded Postgres) and `--serve` (production children only, the Render start command); step summaries logged (`[bootstrap] ok: …`); non-postgres `DATABASE_URL` leaks from the surrounding shell are now rejected instead of silently reaching the children.
- Fixes made while landing T12 (found BY the smoke — its purpose):
  - `apps/api/src/scripts/ensure-auth-tables.ts` (new): the missing dev migrator step applying Better Auth's `auth`-schema DDL + app_user DML grants (the SQL migrations own `app`; `auth` tables were only ever created in the test fixture — a fresh dev DB could not sign anyone up).
  - `public-session.controller.ts`: explicit `@Inject(PublicSessionService/PublicSubmissionsService)` — tsx does not emit decorator type metadata (vitest's SWC pipeline does), so both public controllers got `undefined` services at runtime under `tsx` (TypeError: reading 'createSession' → 500).
  - `supervisor.mjs`: pg boot runs the real `tsx/dist/cli.mjs` entry (the `.bin/tsx` sh shim cannot be executed via `process.execPath`).
- Live-alpha items (the two unchecked boxes) need real Neon/Render/email-provider credentials — this sandbox cannot reach them; the runbook carries the exact steps (ADR-0001: code + CI + runbook now, live run when credentials exist).
- Verification at close: smoke 12/12; api 198/198, web 113/113, db 68/68, contracts 18/18, form-schema 82/82, queue 18/18, supervisor allowlist 11/11.
