# 11: Submission inbox and detail

**Spec:** `../spec.md`

**What to build:** The dashboard inbox with a cursor-paginated submission list per form and a detail view that pairs each answer with the question label from the pinned version, plus the full browser end-to-end path and an accessibility check.

**Blocked by:** 10

**Status:** done

- [x] The submission list is newest-first, cursor-paginated, default 20, maximum 100.
- [x] The detail view shows each answer beside the question label from the pinned version, plus the received time and form version. Labels and answers render as escaped plain text.
- [x] Cross-workspace list and detail requests return 404; RLS tests cover the submission tables.
- [x] The Playwright happy path covers signup, verification, workspace creation, form building, publishing, public submission, and dashboard review.
- [x] An accessibility check runs inside Playwright for sign-in, the dashboard form list, the builder, the submission list and detail, and the public form, and fails on serious violations.
- [x] Inbox labels, empty states, dates, and errors use i18n keys.
- [x] CSV export and analytics are not implemented in this slice.

## Implementation notes

- Contracts: submission inbox list/detail DTOs + OpenAPI paths (`packages/contracts/src/schemas/submission.ts`, snapshot-tested).
- API: `GET /v1/forms/:formId/submissions` (cursor pagination, newest-first, default 20 / max 100) and `GET /v1/submissions/:id` (pinned-version detail pairing answers with question labels); cross-workspace access returns 404.
- DB: `packages/database/test/submissions-rls.test.ts` — 6 RLS seam tests (cross-workspace zero rows, both USING + WITH CHECK clauses on submission tables).
- Web: inbox list + pinned-version detail pages under the dashboard; i18n keys for labels, empty states, dates, errors (`packages/i18n/src/catalog/en.ts`).
- E2E (`e2e/` workspace): Playwright happy path (signup → verification → workspace → builder → publish → public submit → inbox review, 8 assertions) + axe a11y seam (fails on serious violations) + 360px public-form layout check; browsers installed locally, run with `pnpm --filter e2e test` (needs the full stack up via `scripts/supervisor.mjs`).
- Note: branch predated FIX-1, so merge kept integration/m0's allowlist-routed `trusted-ip-rewrite` spawn + web `instrumentation.ts` env guard.
- Verification at merge: build 12/12; api 198/198 (incl. trusted-ip 9/9), web 113/113, db 68/68, contracts 18/18, form-schema 82/82, queue 18/18.
- Follow-up (2026-11-01, live app run): re-running the suite against a fresh `supervisor --dev` exposed a latent spec bug — the serial publish/inbox tests never established their own session (fresh Playwright contexts have isolated cookie jars), so the chain failed at `publish…` with a sign-in redirect. Fixed in `openFormFromDashboard` (sign in per test); suite now passes 8/8. Also re-confirmed `pnpm -w build` is REQUIRED before `supervisor --dev` after pulling: a stale `@form/i18n` dist (pre-ticket-11 catalog) crashes the dashboard shell SSR with "Missing i18n message: dashboard.inbox.open".
