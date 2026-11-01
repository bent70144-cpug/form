# Code review — round 2 (T11 + T12 landing)

Scope: `ticket/11-inbox-e2e` (5 commits), `ticket/12-deploy` (1 commit), plus
the fixes made while landing them on `integration/m0`.

## Verdict

0 CRITICAL / 0 MAJOR / 2 MINOR (accepted, documented) — all suites and the
alpha smoke green at the reviewed commit.

## Verified

- T11 inbox routes: verified-email + workspace-context guards, tenant-scoped
  RLS handle only, 404 (never 403) for unknown/cross-workspace, contract
  schema validation on query params; `packages/database/test/submissions-rls.test.ts`
  covers cross-workspace zero rows and both policy clauses.
- T11 web inbox: no `dangerouslySetInnerHTML` anywhere; labels/answers render
  as escaped text (component comments encode the requirement).
- T12 smoke/supervisor: per-child allowlists unchanged in spirit — new
  production keys (email transport, trusted-proxy, IP hash, submission cap)
  go to the API child ONLY; `packages/config/test/supervisor.test.mjs` (11
  asserts) keeps proving the web child receives no secrets.
- `deploy.yml`: YAML valid; migrate/deploy stay main-only; `smoke-local` runs
  on main + integration/m0.

## Fixes made during landing (each verified)

1. `apps/api/src/scripts/ensure-auth-tables.ts` — missing dev migrator step
   for Better Auth's `auth` schema (fresh dev DB could not sign up).
2. `public-session.controller.ts` — explicit `@Inject` for both public
   controllers (tsx emits no decorator type metadata; undefined services →
   500 on public session create).
3. `supervisor.mjs` — pg boot via the real tsx CLI entry; step summaries;
   non-postgres `DATABASE_URL` shell leaks rejected.
4. `smoke-alpha.mjs` — session DTO shape (flat, not nested) + the
   invalid-answers probe moved to a fresh session (idempotent replay of a
   completed session returns the stored receipt before validation — the
   tested T10 contract).

## Accepted observations (MINOR)

- `trusted-ip-rewrite.test.ts` spawns a real `next dev`; under port or
  watcher contention (many concurrent dev stacks in one sandbox) it can time
  out spuriously — rerun in isolation passes. CI's fresh runner is immune.
- The alpha smoke requires fixed ports (5433/1025) and aborts loudly when
  they are occupied — by design; documented in the script header.
