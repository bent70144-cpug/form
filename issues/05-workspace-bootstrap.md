# 05: Workspace and project bootstrap with outbox and audit foundation

**Spec:** `../spec.md`

**What to build:** An idempotent workspace bootstrap that creates the user's personal workspace, owner membership, and `General` project; the session exposes the active workspace; the API builds the tenant request context; the `workspace.created` event proves the outbox and audit foundation, and a catalog guard prevents forgotten RLS.

**Blocked by:** 03

**Status:** done

- [x] `POST /v1/workspaces/bootstrap` is the trigger for workspace creation and is idempotent; it calls `create_personal_workspace()`, which reads `app.user_id`, and returns the existing or newly created workspace. Repeated calls do not create duplicate workspaces, memberships, or projects. It rejects unverified users.
- [x] For M0, the active workspace is the user's single personal workspace; multi-workspace selection is deferred. The dashboard shell renders a small client component that calls `POST /v1/workspaces/bootstrap` through the browser's same-origin `/v1/*` rewrite when `session.workspace` is null, displays “Setting up your workspace…”, then refreshes into the dashboard. Bootstrap is never called from a server component, and ticket 03's Origin guard has no internal-call exemption. `GET /v1/auth/session` remains a read-only GET that never writes.
- [x] `workspaces.is_personal` plus a partial unique index on the creator enforces at most one personal workspace per user.
- [x] `workspace_members.role` is the enum owner/admin/editor/viewer with a unique `(workspace_id, user_id)`; `workspace_invitations` exists with forced RLS but has no UI or email flow in M0.
- [x] The personal workspace, owner membership, and `is_default` `General` project are created atomically; the session returns the active workspace and the dashboard shows it.
- [x] `create_personal_workspace()` runs as `fn_owner`, a dedicated NOLOGIN role with no `BYPASSRLS`, not as the migrator. Tables remain owned by the migrator with forced RLS, and explicit `TO fn_owner` policies with both `USING` and `WITH CHECK` clauses cover the RLS tables bootstrap functions touch (`workspaces`, `workspace_members`, `projects`, and `audit_logs`); `fn_owner` also gets the necessary table grants, including INSERT on the no-RLS `outbox_events`. Every function pins `search_path`, revokes `PUBLIC` execute, and grants execute only to its caller role.
- [x] Immediately after creating the workspace, `create_personal_workspace()` sets `app.workspace_id` transaction-locally, then inserts the `workspace.created` audit row and outbox event. A test asserts the audit row exists after the first bootstrap and that a repeated bootstrap does not duplicate it. A test also calls the bootstrap function as `app_user` and proves `app_user` cannot read `workspaces` or `workspace_members` directly; those tables are reachable only through `list_workspaces()` and the bootstrap function.
- [x] A Nest interceptor for authenticated workspace routes opens the transaction, sets `app.user_id` from the verified session, resolves the active workspace through the security-definer `list_workspaces()` (not a direct RLS membership query), and sets `app.workspace_id` transaction-locally. Auth, health, public, and bootstrap routes use narrower context; bootstrap runs with only `app.user_id`, and `create_personal_workspace()` sets `app.workspace_id` internally once the workspace exists.
- [x] Workspace, membership, invitation, and project tables have forced RLS and policies with both `USING` and `WITH CHECK`; `list_workspaces()` reads `app.user_id`; cross-tenant reads and writes fail. A test attempts to update a row's `workspace_id` to another tenant and expects the policy to reject it.
- [x] Every tenant relationship uses a composite foreign key on `(workspace_id, parent_id)` referencing a unique `(workspace_id, id)` on the parent. A form cannot reference another workspace's project, and a submission cannot reference another workspace's version or session.
- [x] `outbox_events` has no `workspace_id` column; the workspace ID travels in the payload. It has INSERT-only access for `app_user` and SELECT/UPDATE for `worker_user`; inserts do not use `RETURNING`, because `app_user` has no SELECT grant. Drizzle's default behavior must be overridden where it would add `RETURNING`. A pg-boss dispatcher processes `workspace.created` idempotently and marks it processed.
- [x] The dispatcher claims with `FOR UPDATE SKIP LOCKED`, retries with backoff, and moves events to a dead-letter state after 10 attempts. A restarted worker does not lose or double-process an in-flight event.
- [x] The pg-boss dispatcher uses the interval or strategy selected in ticket 02 and does not add a schedule that keeps Neon awake.
- [x] `audit_logs` exists with forced RLS, is append-only, and records `workspace.created`.
- [x] Later outbox handlers that read tenant tables set `app.workspace_id` from the event payload under the non-bypass `worker_user` role; they never read tenant data through a privileged connection. Cross-tenant maintenance uses narrowly scoped security-definer functions such as ticket 10's `purge_expired_sessions()`.
- [x] The catalog guard test fails if any `app` table with `workspace_id` lacks forced RLS, a policy with both `USING` and `WITH CHECK`, or a composite tenant foreign key; it special-cases `workspaces` by `id`.
- [x] No form creation is implemented in this slice.
- [x] If this slice runs long, split the outbox, dispatcher, audit log, and catalog guard into a separate ticket; keep the workspace bootstrap demoable.

## Implementation notes (2026-10-31)

- `POST /v1/workspaces/bootstrap` idempotent (narrow user-only context; `email_unverified` 403 otherwise); `create_personal_workspace()` fn_owner path; session exposes the active workspace; dashboard bootstrap client component through the same-origin rewrite (never server-side).
- Tenant context interceptor: full workspace context only for marked routes; `list_workspaces()` resolution; transaction-local `app.workspace_id`.
- Outbox dispatcher (pg-boss, 30s cron): FOR UPDATE SKIP LOCKED claims, backoff retries, dead-letter after 10 attempts, restart-safe; `workspace.created` audited + processed idempotently. Catalog guard + RLS/composite-key tests from the DB slice verified in-suite (48 API + worker + database suites green).
