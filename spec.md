# M0 — Walking Skeleton

Status: ready-for-agent

## Problem Statement

An agency owner needs to collect structured client intake information through a conversational form and review every response in one place. Today they either use a generic form tool that mixes client data together and limits control over the respondent experience, or they build one-off pages that are hard to maintain. They need a hosted workspace where a form can be created, published at a shareable link, filled in by an unauthenticated respondent, and reviewed by the agency — with a hard guarantee that one client's workspace can never see another's data.

Before the product can grow into logic, themes, payments, and integrations, the team needs the thinnest end-to-end version that proves the architecture, tenancy model, and deployment path. Without that walking skeleton, every later feature is built on assumptions about authentication, authorization, versioning, and public submission that have never been exercised together.

## Solution

M0 delivers a working conversational-form loop:

- An email/password account with verification and password reset.
- A personal workspace and default project created automatically.
- A block-based form builder supporting welcome, short-text, long-text, and ending blocks.
- A draft that can be saved and edited independently of a published form.
- Immutable published versions with a stable public URL at `/f/{slug}`.
- A public respondent flow that creates a pinned form session, validates answers on the server, and stores a submission.
- A dashboard inbox that lists submissions and shows each answer beside the question from the version the respondent actually saw.
- Tenant isolation enforced by Postgres row-level security, not only by application checks.
- A local development stack and a single-service alpha deployment backed by Neon Postgres.

M0 deliberately excludes logic, themes, uploads, analytics, payments, integrations, public developer APIs, translated content and locale switching, custom domains, and embed. Plain English strings are externalized so translation does not require a rewrite later.

## User Stories

### Identity and access

1. As a prospective workspace owner, I want to create an account with email and password, so that I can start building forms without waiting for an invite.
2. As a new account holder, I want to verify my email address, so that my account cannot be impersonated and I can recover it.
3. As a returning user, I want to sign in with my email and password, so that I can access my workspace.
4. As a signed-in user, I want to sign out, so that I can safely leave a shared computer.
5. As a user who forgot my password, I want to reset it by email, so that I can regain access.
6. As a signed-in user, I want my session to survive a page reload but remain revocable server-side, so that I stay signed in without a stolen cookie working forever.
7. As a signed-out visitor, I want to be redirected to sign-in when I open a dashboard page, so that I know I need to authenticate.
8. As a user whose session was revoked, I want my next dashboard request to send me to sign-in, so that a stale tab cannot keep acting as me.
9. As an operator, I want the session endpoint to return a minimal session object, so that dashboard rendering does not fetch more personal data than it needs.
10. As an operator, I want invalid or expired sessions to receive a 401 with no sensitive detail, so that session probing reveals nothing.

### Workspace and project

11. As a newly verified user, I want a personal workspace created automatically, so that I can create a form immediately.
12. As a workspace owner, I want a default project created automatically, so that I do not have to organize work before my first form.
13. As a workspace owner, I want to see which workspace I am working in, so that I know where my forms will live.
14. As a workspace owner, I want my forms and submissions to be invisible to other workspaces, so that I can put client data into the platform safely.
15. As a workspace owner, I want workspace membership and roles represented in the data model, so that multi-user collaboration can be added without a schema rewrite.

### Form building

16. As a form creator, I want to create a new form, so that I can start collecting client information.
17. As a form creator, I want to name and rename a form, so that I can identify it later.
18. As a form creator, I want to add a welcome block with a title and description, so that respondents understand the purpose before answering.
19. As a form creator, I want to add a short-text question, so that I can collect a name, email, or other brief answer.
20. As a form creator, I want to add a long-text question, so that I can collect a detailed brief or message.
21. As a form creator, I want to add an ending block with a title and description, so that respondents know their answer was received.
22. As a form creator, I want to mark a question as required, so that I receive the information I need.
23. As a form creator, I want to edit a question's label, description, and placeholder, so that the form reads clearly.
24. As a form creator, I want to reorder blocks, so that the conversation flows in the order I intend.
25. As a form creator, I want to delete a block, so that I can remove questions I no longer need.
26. As a form creator, I want my draft to save without publishing, so that I can work incrementally.
27. As a form creator, I want to see whether my draft is saved, so that I do not lose work.
28. As a form creator, I want server-side validation of my draft schema, so that malformed or unsupported blocks never reach a published form.
29. As a form creator, I want each block to keep a stable identifier across edits, so that answers and logic references do not silently switch targets.

### Publishing and versions

30. As a form creator, I want to publish my form, so that I can share it with respondents.
31. As a form creator, I want a stable, short public link after publishing, so that I can share it easily.
32. As a form creator, I want to see that my form is published, so that I know the link is live.
33. As a form creator, I want to keep editing the draft after publishing without changing what respondents currently see, so that I can prepare the next version safely.
34. As a form creator, I want to republish my draft as a new immutable version, so that respondents get the updated form without losing the record of what earlier respondents saw.
35. As a form creator, I want to unpublish my form, so that new respondents cannot open it.
36. As a form creator, I want old links to continue working after a slug rename, so that previously shared links do not break.
37. As a form creator, I want reserved words rejected as slugs, so that public routes do not collide with application routes.
38. As a form creator, I want publish to be atomic, so that a failed validation never leaves a half-published form.

### Public respondent flow

39. As a respondent, I want to open a public form link without creating an account, so that I can answer immediately.
40. As a respondent, I want to see the welcome screen, so that I understand what the form is for.
41. As a respondent, I want to answer short-text and long-text questions, so that I can provide the requested information.
42. As a respondent, I want clear validation when a required answer is missing, so that I know what to fix before submitting.
43. As a respondent, I want to submit my answers once, so that I receive confirmation without creating duplicates.
44. As a respondent, I want to see the ending screen after submitting, so that I know my response was received.
45. As a respondent, I want the form to be readable on my phone, so that I can answer without zooming or horizontal scrolling.
46. As a respondent using a keyboard or screen reader, I want labels, focus order, and errors to be accessible, so that I can complete the form independently.
47. As a respondent, I want a clear message when a form is closed, deleted, or no longer published, so that I do not waste time trying to submit.
48. As a respondent who loaded a form before it was republished, I want my in-flight session to keep working for a limited time, so that my answers are not lost mid-completion.
49. As a respondent, I want my session to expire after a reasonable period, so that an abandoned form cannot be submitted indefinitely.
50. As a respondent, I want the public form excluded from search engines by default, so that client intake links are not indexed.
51. As a respondent, I want the public endpoint to expose only the published version, so that drafts and internal data never appear in the browser.

### Submissions and review

52. As a workspace owner, I want to see a list of submissions for a form, so that I can review responses.
53. As a workspace owner, I want the list to show when each response arrived, so that I can triage recent work.
54. As a workspace owner, I want to open a submission and see each answer beside the question that produced it, so that I can understand the response without guessing.
55. As a workspace owner, I want to see which form version a submission used, so that I can trust the record when the form has since changed.
56. As a workspace owner, I want submissions from different forms and workspaces kept separate, so that client data cannot leak into the wrong inbox.
57. As a workspace owner, I want a double-click or retry on submit not to create a duplicate response, so that my inbox stays clean.
58. As a workspace owner, I want a submission to belong to exactly one pinned session, so that one respondent cannot accidentally overwrite another.

### Security, audit, and operations

59. As a signed-out person, I want dashboard and management APIs to reject me, so that form data is not publicly readable.
60. As a member of the public, I want only published forms to be readable through the public endpoint, so that drafts are never exposed.
61. As a workspace owner, I want security-relevant actions recorded in an audit log, so that I can reconstruct who created, published, or deleted something.
62. As an operator, I want a health endpoint, so that the deployment platform can tell whether the service is alive.
63. As an operator, I want the app to run locally with one documented command, so that development does not depend on tribal knowledge.
64. As an operator, I want a one-time admin bootstrap to create schemas and roles, and migrations to create tenant-safe policies, functions, and grants, so that a fresh database is tenant-safe by construction.
65. As an operator, I want the alpha deployed as a single service with web, API, and worker processes, so that I can validate the product on a free tier.
66. As an operator, I want verification emails to go to Mailpit locally and a real provider in deployed environments, so that I can test without sending real mail.
67. As an operator, I want the queue to survive process restarts, so that form and submission events are not lost.
68. As an operator, I want the database connection strategy to work with pooled and direct Neon connections, so that the app and queue do not interfere with each other.
69. As a developer, I want the web app to fail lint or build if it imports database or server-auth code, so that the browser deployable never gets database credentials.
70. As a developer, I want a single OpenAPI description generated from the request and response schemas, so that the web client and future public API cannot drift.

## Implementation Decisions

### Scope and delivery order

M0 is the first milestone of a larger product. The order is: monorepo foundation and local health, alpha topology spike, then the create → publish → submit → view vertical slice. The spike is intentionally early because the single-service topology, the Next.js `/v1/*` rewrite, and pg-boss against Neon are the riskiest unverified assumptions.

No later-milestone feature should leak into M0 merely because it is cheap. The acceptance criterion is a working loop with real tenancy, not a broad but shallow prototype.

### Repository and runtime

A pnpm + Turborepo TypeScript monorepo with three entrypoints: web (Next.js App Router), API (NestJS REST under `/v1`), and worker (pg-boss now, BullMQ at beta). The web app renders both the dashboard and the public form pages. The API owns all database access for request handling. The worker owns asynchronous processing.

Package boundaries:

- A database package owns the Drizzle schema, migrations, RLS SQL, bootstrap functions, and the transaction wrapper.
- A contracts package owns Zod request/response schemas and OpenAPI generation.
- A form-schema package owns the block union, schema validation, and version migrations. It has no Node or DOM dependencies.
- A logic package will own the pure visibility/jump/variable engine. M0 creates the package boundary but implements no rules.
- A UI package owns shared React components.
- An i18n package owns message catalogs and helpers; M0 ships English only but externalizes strings.
- A queue package owns the `JobQueue` port and the pg-boss adapter.
- An auth package has two explicit entrypoints. The server entry exports the DB-backed Better Auth instance and may only be imported by the API. The client entry exports shared types and a typed session client and may be imported by the web app.
- A config package owns shared TypeScript, lint, and style presets.

Dependency rule: apps may depend on packages, packages may depend on packages, and no package may depend on an app. The database package is the only request-path package that touches Postgres, with two explicit exceptions: the queue package owns the pg-boss adapter, and the auth package owns the `auth` schema. The `pgboss` schema DDL is installed by the migrator, not at runtime. Everything else goes through the database package.

### Identity and sessions

Better Auth provides email/password, email verification, password reset, and session storage in the `auth` Postgres schema. The Better Auth handler is mounted in the NestJS API under `/v1/auth/*`; the browser reaches it through the same-origin Next.js rewrite, so cookies stay first-party.

Signup, sign-in, and reset responses are enumeration-safe: they never reveal whether an email address exists. Passwords are 12–128 characters. A reset token is single-use and expires after one hour; completing a reset revokes all existing sessions. Unverified users may sign in, but bootstrap, workspace, form, and submission-management routes return 403 `email_unverified`; the dashboard shows a resend-verification prompt. No workspace is created until verification succeeds.

The alpha spike configures Better Auth to generate UUID user IDs for the pinned version, or records a decision to use text IDs consistently in `app.user_id` and policies. The two choices must not diverge.

The web app never imports the DB-backed auth instance and never receives `DATABASE_URL` or auth secrets. Next.js server components validate the session by calling `GET /v1/auth/session` on the internal API URL with the incoming cookie forwarded. The call is wrapped in React's `cache()` so multiple components on one render share one request. Browser-initiated calls use the same-origin `/v1/*` rewrite; server-side calls go directly to the internal API port, not through the public domain or the rewrite. Public form pages never call the session endpoint.

`GET /v1/auth/session` returns a minimal object: user ID, email, verified flag, and the active workspace ID, name, and role if one exists. Invalid or expired sessions return 401 with no body detail.

Next.js middleware performs only a cheap cookie-presence check to redirect obviously logged-out dashboard visits. It is not a security boundary. Every API mutation re-checks the session and workspace membership itself; an SSR render having seen a valid session earlier authorizes nothing.

All state-changing calls originate in the browser through the same-origin `/v1/*` rewrite; there is no internal-call Origin exemption. Cookie-authenticated mutations pass a global Origin check that runs before both Nest controllers and the mounted Better Auth handler: the Origin header must match the configured app origin, and missing or mismatched origins are rejected before the handler runs. The only exemptions are an explicit route allowlist for cookie-less endpoints: public session creation, public submit, and the token-based email-verification link. An exempted route never reads the auth cookie. Better Auth's trusted origins are set to the same app origin.

Auth endpoints are rate-limited. Signup allows 5 attempts per hour per IP; sign-in allows 10 attempts per 15 minutes per IP and per email; reset requests allow 3 per hour per email and 10 per hour per IP; the session endpoint allows 120 requests per minute per IP. Exceeding a limit returns 429 with stable `rate_limited`.

Session cookies are HttpOnly, Secure in production, SameSite=Lax, with a seven-day rolling expiry and server-side revocation. Google OAuth, TOTP, OIDC/SSO, and workspace invitations are deferred; the invitation table exists but has no UI or email flow in M0.

### Tenancy and authorization

The domain lives in an `app` schema. Better Auth lives in `auth`; pg-boss lives in `pgboss`. A one-time admin bootstrap, run with admin credentials, creates the `app`, `auth`, and `pgboss` schemas owned by `migrator` and the `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` roles. Migrations run as the `migrator` table owner. Request handling uses a non-owner `app_user` with no `BYPASSRLS`; the worker uses a separate `worker_user` for outbox reads, updates, and narrowly scoped maintenance. Security-definer functions are owned by `fn_owner`, which also has no `BYPASSRLS`.

Every tenant-owned table carries `workspace_id NOT NULL` and has RLS enabled and forced. The `workspaces` table is keyed by `id`; its policy uses `USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)` with the same expression in `WITH CHECK`. The policy pattern for the other tenant tables is:

```
USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
```

`nullif` turns an unset or reset transaction setting into NULL instead of an invalid UUID string, so a query without tenant context returns no rows rather than raising a cast error. `USING` alone is insufficient. Every app-user policy carries both clauses so an UPDATE cannot move a row to another workspace and an INSERT cannot create a row in one. A test attempts to change `workspace_id` to another tenant and expects rejection.

Forced RLS applies to table owners too, so security-definer functions cannot rely on ownership. Each function runs as `fn_owner`, and `fn_owner` receives explicit `TO fn_owner` policies with both clauses on the RLS tables that function touches, plus ordinary table grants for the no-RLS outbox. These policies are function-scoped, not the `app_user` tenant policy. `create_personal_workspace()` generates the workspace UUID and sets `app.workspace_id` before inserting the workspace, membership, project, audit row, and outbox event, so the insert checks pass. `list_workspaces()` reads only memberships whose `user_id` equals `app.user_id`; the `fn_owner` policy on `workspace_members` permits that lookup, and the `fn_owner` policy on `workspaces` permits a row when the caller has a membership. Public read functions may read published forms, versions, and slugs across tenants and filter by slug; `register_form_slug()` writes only when `workspace_id = app.workspace_id`. This avoids `BYPASSRLS` on Neon. The functions are the only code that runs as `fn_owner`. A test calls each function as `app_user` and proves the caller cannot read the underlying table directly: `workspaces` and `workspace_members` have no direct `SELECT` grant and are reachable only through `list_workspaces()` and `create_personal_workspace()`, while tenant tables reachable directly still return no rows outside the active workspace.

Every tenant relationship uses a composite foreign key on `(workspace_id, parent_id)` referencing a unique `(workspace_id, id)` on the parent, except the root link to `workspaces`, which is `workspace_id -> workspaces(id)`. This prevents a form from referencing another workspace's project, or a submission from referencing another workspace's version or session. The catalog guard checks both the policy clauses and the composite keys and exempts only the root workspace reference.

Each request runs in a transaction that sets `app.workspace_id` transaction-locally with `set_config(..., true)`. A repository wrapper refuses tenant queries executed outside that transaction. A missing setting yields NULL and therefore no rows, rather than an error that could be mistaken for an empty result. A pooled-connection test asserts `app.workspace_id` is empty immediately after a transaction ends, so context cannot leak between requests.

A Nest interceptor for authenticated workspace routes opens the transaction, sets `app.user_id` from the verified session, resolves the user's active workspace through the security-definer `list_workspaces()` (not a direct RLS membership query), and sets `app.workspace_id` transaction-locally. Auth, health, public, and bootstrap routes use narrower context. For M0 the active workspace is the user's single personal workspace; multi-workspace selection is deferred.

Workspace creation is triggered by an idempotent `POST /v1/workspaces/bootstrap`, which calls `create_personal_workspace()` and returns the existing or newly created workspace. A small dashboard client component calls it through the browser's same-origin `/v1/*` rewrite when `GET /v1/auth/session` returns a null workspace, shows “Setting up your workspace…”, and refreshes; bootstrap is never called from a server component. The session endpoint remains a read-only GET.

Bootstrap and cross-tenant operations are solved with narrowly scoped security-definer functions:

- `list_workspaces()` reads `app.user_id` from the transaction, not a caller-supplied ID, and returns only workspace IDs, names, and the caller's role.
- `create_personal_workspace()` is idempotent and reads `app.user_id`. It creates the user's personal workspace, owner membership, and `is_default` `General` project in one transaction. Immediately after creating the workspace it sets `app.workspace_id` transaction-locally, then inserts the `workspace.created` audit row and outbox event. A first-bootstrap test asserts the audit row exists, and a repeated bootstrap does not duplicate it. `workspaces.is_personal` plus a partial unique index on the creator guarantees at most one personal workspace per user.
- `resolve_public_form(slug)` is the session-creation path: it returns only the published, non-deleted form's ID, workspace ID, version ID, and minimal metadata. It never returns drafts.
- `get_published_form(slug)` is the render path: it returns the published snapshot read-only plus a status (`published`, `closed`, `redirect`, or `not_found`) and, for `redirect`, the canonical slug. Soft-deleted forms return `closed`. It never returns drafts. A future password gate will sit in front of this function. The two functions are intentionally distinct: rendering needs the schema, while session creation needs IDs and pinning metadata.
- `register_form_slug(form_id, slug)` is the only write path into the global `form_slugs` registry; it verifies the form belongs to `app.workspace_id`, and the registry itself gets no broad grants.
- `resolve_form_session(token_hash)` resolves a public session to its form, pinned version, and expiry state, applying the 24-hour usability window and the 5-minute acceptance grace.
- `purge_expired_sessions()` deletes sessions expired for more than seven days across tenants. It is owned by `fn_owner`, granted only to `worker_user`, and is the worker's only cross-tenant access to `form_sessions`.

All of these pin `search_path`, revoke execute from PUBLIC, and grant execute only to their caller role: `app_user` for request-path functions and `worker_user` for `purge_expired_sessions()`. `audit_logs` grants INSERT to `app_user` and `fn_owner` and SELECT to `app_user`, and has forced RLS. `outbox_events` grants INSERT to `app_user` and `fn_owner`, and SELECT/UPDATE to `worker_user`, so the request-serving role cannot read other tenants' events.

Roles are owner, admin, editor, and viewer. M0 only creates an owner membership; the role model and membership table are present so collaboration does not require a migration later.

### Data model

M0 creates these domain tables:

- `workspaces`: identity, display name, creator, `is_personal` flag, timestamps, soft-delete marker; a partial unique index on the creator enforces at most one personal workspace per user.
- `workspace_members`: workspace, user, role, timestamps; unique per workspace/user.
- `workspace_invitations`: workspace, email, role, hashed token, expiry, inviter, acceptance timestamp. Table only in M0.
- `projects`: workspace, name, `is_default` flag, timestamps, soft-delete marker. The default `General` project is found by flag, never by name.
- `forms`: workspace, project, `name` as the dashboard label, status (`draft`, `published`, `closed`), current draft pointer, published version pointer, creator, timestamps, soft-delete marker. Respondents see the pinned schema's `title`, not `forms.name`.
- `form_drafts`: workspace, one mutable row per form, holding the full schema JSONB, integer `draft_version` starting at 0 and incremented on every save, last editor, update timestamp.
- `form_versions`: workspace, immutable published snapshots with a monotonically increasing version number per form, schema JSONB, publisher, publish timestamp; unique on `(form_id, version_number)`.
- `form_slugs`: workspace, global registry mapping a slug to a form, with a current/redirect flag and timestamps; unique slug globally.
- `form_sessions`: workspace, form, pinned form version, hashed session token, creation/expiry/completion timestamps, IP hash, user agent; expired sessions are cleaned up after seven days.
- `submissions`: workspace, form, pinned form version, form session, answers JSONB, metadata JSONB, timestamps, soft-delete marker; unique on `form_session_id` (one submission per session).
- `outbox_events`: event type, payload JSONB (including the workspace ID), availability time, dispatch/processing timestamps, attempt count, last error, dead-letter timestamp. No RLS; the payload carries IDs, not PII.
- `audit_logs`: workspace, actor, action, target type/ID, metadata JSONB, IP hash, timestamp. Forced RLS; append-only.

Every tenant table has a unique `(workspace_id, id)` key for composite foreign keys, and every tenant relationship references that pair. `workspaces` is the special case keyed by `id`. IDs are UUIDv7 for time-sortable internal keys unless the alpha spike selects text Better Auth user IDs; in that case user IDs use text consistently in app tables and policies. Timestamps are `timestamptz` in UTC. Soft deletes use `deleted_at`; public resolution excludes deleted and non-published forms immediately.

### Form schema and versioning

A form is a sequence of blocks, not a flat field list. The stable envelope is:

```
{
  schemaVersion: 1,
  title: string,
  blocks: Block[],
  logic: LogicRule[],   // empty in M0
  theme: Theme,         // default preset in M0
  settings: FormSettings
}
```

The M0 block union:

```
type Block =
  | { id: string; kind: "welcome"; title: string; description?: string }
  | { id: string; kind: "short_text"; label: string; description?: string; required: boolean; placeholder?: string }
  | { id: string; kind: "long_text"; label: string; description?: string; required: boolean; placeholder?: string }
  | { id: string; kind: "ending"; title: string; description?: string }
```

Only question blocks produce answers. Answers are a JSON object keyed by block ID, with string values in M0. Block IDs are 12-character URL-safe IDs generated by the client when a block is added (nanoid); the server enforces `^[A-Za-z0-9_-]{10,32}$` and uniqueness within the form. IDs are stable across edits. Statement, choice, date, file, and other block kinds are added later without changing the envelope.

The empty draft is exactly `{ schemaVersion: 1, title: "", blocks: [], logic: [], theme: { preset: "default" }, settings: {} }`; the form-schema package exports `emptyDraft()` and the default theme/settings.

Publish validation checks unique block IDs, supported kinds, non-empty labels or titles, at least one question block, at most one welcome and one ending block, a welcome block first if present, an ending block last if present, and the global limits of 200 blocks, 50 logic rules, and 20 jumps. M0 has no logic, so rule and jump validation is structural only. Published schemas are immutable; `schemaVersion` migrations are explicit registered functions, never in-place JSON edits. A `migrateSchema` registry stub handles version 1 as identity.

Concrete limits are enforced in the shared schema. Text fields count characters: form title 200, block label/title 500, description 2,000, placeholder 200, a short-text answer 1,000, and a long-text answer 10,000. JSON caps count bytes: draft schema 256 KB and submission payload 100 KB. The JSON cap governs when per-field maxima would exceed it, and the API returns a stable `schema_too_large` or `submission_too_large` code. Labels, descriptions, placeholders, and titles are plain text; the renderer escapes them. NUL (`\u0000`) is rejected with `invalid_character` on draft save and submit because Postgres JSONB cannot store it. Request body limits are set explicitly per route: about 300 KB for draft save, 150 KB for submit, and small defaults elsewhere. The limit is configured rather than inherited from the Express or Fastify adapter's default. Publish warns when the worst-case answer size for a form, using each question kind's own cap, would exceed the submission cap.

Draft saves replace the full draft schema atomically. M0 is single-editor; collaborative editing is out of scope, but a supplied `draft_version` that does not match the stored integer is rejected with 409 rather than silently overwriting another tab. The version starts at 0 and increments on every successful save. The builder serializes its own saves so one tab cannot conflict with itself.

Publishing is one transaction: lock the form row, validate the draft, allocate the next version number, insert the immutable version, update the published pointer and status, register or update the slug, insert an audit entry, and insert the `form.published` outbox event. An injected failure rolls back all of it, concurrent publishes serialize on the form row, and the dashboard exposes Publish, Republish, and Unpublish controls, status, version number, copy-link, and the worst-case-size warning.

Publishing sets the form status to `published`. Unpublish sets it to `closed`; republish reopens it. A soft-deleted form also resolves to `closed`, so a respondent sees the closed message rather than a generic 404. The public API distinguishes `closed` from `not_found`.

Sessions pin the published version they started on. A session is usable for 24 hours; submissions are accepted for a five-minute grace window after expiry, and expired sessions are cleaned up after seven days. If the form is unpublished, closed, or deleted, submission is rejected even for a pinned session.

Slugs are 10-character base62 by default. A reserved-word list prevents collisions with application routes. The first publish allocates a slug through `register_form_slug`; a later rename keeps the old slug as a redirect in the registry, and the public API returns a `redirect` status with the canonical slug. M0 has no rename UI, so redirect behavior is exercised directly through the registry and API seam. Custom aliases are a paid-plan feature and are out of scope for M0.

### Public form and submission lifecycle

The public URL is `/f/{slug}`. The web app has no database access, so Next.js SSR calls an unauthenticated `GET /v1/public/forms/{slug}` over the internal API URL. That endpoint wraps `get_published_form(slug)`, which returns the published snapshot and a status (`published`, `closed`, `redirect`, or `not_found`); `not_found` maps to 404, `closed` (including a soft-deleted form) renders the closed message, and `redirect` answers with a 308 permanent redirect to the canonical `/f/{slug}`. Both the public API response and the SSR page send `Cache-Control: no-store` in M0, so unpublish and republish take effect immediately. The page renders the welcome, question, and ending blocks, with all creator text escaped, without creating a session. A future password gate sits in front of the same endpoint. Session creation uses the distinct `resolve_public_form(slug)`, which returns IDs and pinning metadata rather than the render snapshot, and returns the raw session token, expiry, pinned version ID, and published schema. `app.workspace_id` for public session creation and submit is set from the resolved form, never from the client. The raw token is returned once; only its hash is stored. The client keeps it in memory or session storage and sends it as `X-Form-Session`; M0 does not depend on third-party cookies, so the flow remains embeddable later.

Submission is one server-side transaction:

1. Resolve the form and session by token hash.
2. Reject missing, expired beyond the five-minute grace window, completed, or mismatched sessions.
3. Verify the form is still published and the pinned version still exists.
4. Validate the answer object against the pinned schema. Unknown block IDs, answers to non-question blocks, missing required answers, whitespace-only answers to required questions, over-limit values, NUL characters, and oversized submission payloads are rejected with stable error codes.
5. Discard answers to hidden blocks. M0 has no logic, so this is enforced structurally; when logic arrives, the server will re-evaluate visibility from the pinned version and raw answers and discard values for hidden blocks rather than storing them flagged.
6. Lock the form row and enforce the configurable per-form submission cap (default 1,000 in the alpha), returning 409 `form_full` when reached so a public form cannot exhaust the free database.
7. Insert the submission with a unique `form_session_id`, so each session has at most one submission. A retry, including the loser of a concurrent double-submit race, returns a receipt (`submitted: true` plus submission ID) without returning stored answers.
8. Mark the session completed.
9. Insert the `submission.created` outbox event and the audit entry in the same transaction.

The worker deletes sessions expired for more than seven days through `purge_expired_sessions()`, a security-definer function owned by `fn_owner` and granted only to `worker_user`; the worker never reads `form_sessions` across tenants directly.

Session creation is limited to 30 requests per hour per IP and per form. The client IP is taken from the trusted proxy chain (Render now, Cloudflare when added), not an arbitrary client-supplied header; tests exercise the real browser → Next.js `/v1/*` rewrite → NestJS hop and cover spoofed cases. Stored IP metadata is an HMAC of that address with a server secret, not a reversible hash. The server is authoritative. Client-side validation is a convenience; it never determines what is stored. At 360px CSS width the public form has no horizontal scrolling, and every input has a programmatically associated label and error. Responses use a stable error code plus a human-readable message; messages are selected through i18n keys.

Public pages are `noindex` and `no-store`. M0 has no password gate, captcha, partial submissions, or file uploads; the schema envelope reserves their settings but the renderer ignores them.

### API conventions

REST under `/v1`, JSON, camelCase, and ISO-8601 UTC timestamps. Internal IDs are UUIDs. Better Auth user IDs follow the spike decision (UUID generation or text IDs) and use the same representation in app tables and policies. OpenAPI is generated from the shared Zod contracts and served at `/v1/openapi.json`.

Errors use RFC 9457 Problem Details with a stable `code` and optional field errors:

```
{
  "type": "https://form.example/errors/validation",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "...",
  "errors": [{ "path": "answers.block_id", "code": "required", "message": "..." }]
}
```

Status conventions: 400 malformed request, 401 unauthenticated, 403 authenticated but not permitted (including `email_unverified`), 404 not found or cross-tenant (to avoid enumeration), 409 state conflict (including `draft_conflict` and `form_full`), 422 validation, 429 rate limited, 500 unexpected. No stack traces or internal identifiers leak.

List endpoints use cursor pagination with a default page size of 20 and a maximum of 100. Submission lists are ordered newest first by `(created_at, id)`.

M0 endpoints:

- Auth: Better Auth's email sign-up, sign-in, sign-out, verification, and reset handlers under `/v1/auth/*`, all rate-limited; plus the minimal `GET /v1/auth/session`.
- Workspaces: `POST /v1/workspaces/bootstrap` (idempotent, requires a verified email); list the caller's workspaces (the session response carries the active one).
- Forms: create, list, read, rename, replace draft, publish, unpublish.
- Submissions: list per form, read one.
- Public: `GET /v1/public/forms/{slug}` returns the read-only snapshot, status, and canonical slug on redirect, with `Cache-Control: no-store`; `POST /v1/public/forms/{slug}/sessions` creates a pinned session and is rate-limited to 30 per hour per IP and form; `POST /v1/public/submissions` submits answers with `X-Form-Session`.
- Operations: health and OpenAPI.

Submission idempotency is session-scoped. The unique constraint on `form_session_id` is the source of truth. A retry, including the loser of a concurrent double-submit race, returns a receipt without stored answers and never returns another session's submission.

The builder sends the full draft on save plus the last-seen integer `draft_version`. If it does not match the stored version, the API returns 409 `draft_conflict` instead of silently overwriting. Collaborative editing remains deferred.

### Queue, outbox, and audit

Every side effect that must survive a crash is written to the outbox in the same transaction as the domain change. The outbox table, worker grants, and dispatcher are introduced with the workspace bootstrap slice, the first producer. A pg-boss scheduled job dispatches available outbox rows to idempotent handlers, using the interval or strategy selected in the alpha topology spike so it does not keep Neon awake. The dispatcher claims with `FOR UPDATE SKIP LOCKED`, retries with backoff, and moves events to a dead-letter state after 10 attempts. A worker restart mid-dispatch does not lose or double-process an in-flight event. The request role inserts without `RETURNING` because it has no SELECT grant.

When a later outbox handler reads tenant tables, it sets `app.workspace_id` from the event payload under the non-bypass `worker_user` role rather than reading through a privileged connection. Cross-tenant maintenance uses narrowly scoped security-definer functions such as `purge_expired_sessions()`.

pg-boss uses the `pgboss` schema and a direct Postgres connection, not the pooled application connection, because transaction-mode pooling can break session-scoped features such as advisory locks. The schema DDL is installed by the migrator, and the runtime role receives DML only; the spike confirms the pg-boss version can skip its own migration. If direct connections are unavailable, the queue design changes before feature work.

The `JobQueue` port exposes enqueue, schedule, and worker registration. The pg-boss adapter implements it now; BullMQ replaces it at beta without changing domain code.

Audit entries are written for workspace creation, form creation, publish, unpublish, and submission creation in M0. The audit table is append-only; the application role cannot update or delete rows.

### Deployment and configuration

Local development uses Postgres and Mailpit. Docker is not currently installed in the working environment; the first task of the foundation slice is to install Docker or document and use an equivalent Postgres/Mailpit setup, because one-command local dev and Testcontainers depend on it. A one-time admin bootstrap script run with admin credentials creates the `app`, `auth`, and `pgboss` schemas and the `migrator`, `app_user`, `worker_user`, and NOLOGIN `fn_owner` roles. Migrations then run as the `migrator` and create tables, forced RLS policies, security-definer functions, and grants. Role passwords come from environment variables, never migration files.

The alpha deploys as one Render free web service. A small supervisor starts Next.js on the public port, NestJS on an internal port, and an inline worker. The supervisor spawns each child with an explicit allowlisted environment: Next receives only public variables and the internal API URL, never `DATABASE_URL`, auth secrets, or the migrator URL. A test fails if a forbidden key appears in the Next process environment. This is process-level separation only; real service isolation arrives with the beta split. Next.js rewrites `/v1/*` to NestJS, and server-side session calls go directly to the internal API URL. The alpha uses the platform-provided `onrender.com` hostname; Cloudflare and custom domains arrive later.

GitHub Actions runs migrations as the `migrator` with a secret stored there, then triggers the Render deploy; Render auto-deploy on push is disabled so new code cannot start before the schema exists. Render's free tier does not support a pre-deploy migration command, and the migrator URL never appears in Render's runtime environment. The final deployment milestone is a smoke test, not the first deploy.

The beta splits web, API, and worker into separate services, moves to paid Render and Neon, and switches the queue to Redis/BullMQ. The 30-day backup retention promise starts at the paid beta because the free Neon tier does not provide adequate backups. Erased data may persist in backups for up to 30 days; the privacy policy must say so.

Environment configuration separates the pooled application URL from the direct migration/queue URL: the app uses the pooled URL, while the migrator and pg-boss use the direct URL. The Next process receives no database URL and no auth secret; the supervisor's allowlist enforces that at the process level, with real service isolation arriving at beta. Auth secrets, email provider keys, and sentry credentials stay server-side. Verification email uses Mailpit locally and a real HTTPS email API in deployed environments; the HTTPS adapter is wired in the auth-core slice, and deployed logs must never contain verification tokens. The provider's sandbox may deliver only to the account owner's address during development; before the first outside tester, a sending domain is owned and verified (roughly $10/year; confirm current pricing), because the `onrender.com` hostname cannot be verified as a sender domain.

The app runs behind Render and later Cloudflare. It trusts only the platform's forwarded client-IP header, so auth and session rate limits and IP HMACs use the real client address. Tests exercise the actual browser → Next.js `/v1/*` rewrite → NestJS hop, and spoofed forwarded headers cannot change the derived address. The limiter is in-memory for the single-process alpha and moves to shared storage at beta. Structured logs redact cookies, auth tokens, and authorization headers; environment configuration is Zod-validated and fails at startup.

Deployment runs migrations from GitHub Actions as the migrator before triggering the deploy. The app connects as `app_user`; the worker connects as `worker_user`; security-definer functions are owned by `fn_owner`. A health endpoint reports process liveness and database reachability without exposing tenant data.

### Engineering guardrails

- The web build and lint fail if the web app imports the database package or the server auth entrypoint.
- CI checks the Next process environment for database credentials, auth secrets, and the migrator URL; the supervisor passes an explicit allowlist.
- Structured logs redact cookies, auth tokens, authorization headers, and tenant payloads; a logged request never contains a reusable credential.
- The API never trusts a workspace ID from the client; it derives the active workspace from the verified session and re-checks membership on every mutation.
- Public endpoints never accept a workspace ID; they resolve it from the form or session, and session creation and submit set `app.workspace_id` from the resolved form under forced RLS.
- Admin/manager endpoints return 404 for resources belonging to another workspace, not 403, to avoid confirming existence.
- All tenant queries go through the transaction wrapper that sets the workspace context.
- Migrations are additive and reviewed for RLS coverage. Every tenant table needs forced RLS, a policy with both `USING` and `WITH CHECK`, and composite `(workspace_id, id)` foreign keys; a new tenant table without them is a defect.
- No runtime role or security-definer owner has `BYPASSRLS`; cross-tenant operations use functions owned by `fn_owner` with explicit `TO fn_owner` policies.
- Creator text is rendered as escaped plain text; public pages and APIs send `Cache-Control: no-store` until an explicit purge story exists.
- API error codes are stable and human-readable messages come from i18n keys.

## Testing Decisions

Good tests assert externally observable behavior: HTTP status and body, rendered UI, stored submission, and database visibility as a specific role. They do not assert private function calls, internal module structure, or implementation details that a refactor should be free to change.

The M0 seams are:

1. **Browser seam — Playwright, primary acceptance.** One happy-path test drives signup, email verification through Mailpit, workspace creation, form building, publishing, public submission, and dashboard review. It covers Publish, Republish, Unpublish, status, copy-link, version number, and the worst-case-size warning. It runs the public form at a 360px viewport and checks for no horizontal scrolling, and runs the accessibility check on sign-in, the dashboard form list, the builder, the submission list and detail, and the public form. Additional browser contexts cover a revoked session redirect and a closed-form message.
2. **HTTP API seam — NestJS against a real Postgres.** Integration tests cover draft/published isolation; atomic publish rollback with an injected failure; concurrent publishes; pinned-version submission within the 24-hour window and beyond the five-minute grace; one-submission-per-session retry behavior including the concurrent loser; revoked-session 401; enumeration-safe signup, sign-in, and reset; the unverified-route 403; Origin-check rejection and the cookie-less allowlist; auth and public-session rate limits with trusted and spoofed forwarded headers across the Next.js rewrite hop; cross-workspace 404; stale-`draft_version` conflicts and the builder's serialized-save race; NUL and whitespace-only answer validation; the per-form `form_full` cap; draft conflicts; validation errors; public `no-store`; the old-slug redirect; the soft-deleted-form closed response; and OpenAPI contract shape. They also cover workspace-bootstrap idempotency and the first-bootstrap audit row, the request context setting `app.user_id` and `app.workspace_id`, the public snapshot status (`published`, `closed`, `redirect`, `not_found`), and a worker restarting mid-dispatch.
3. **Database seam — `app_user` against Postgres.** Direct tests assert SELECT/INSERT/UPDATE/DELETE isolation across workspaces; the behavior of `list_workspaces()`, `create_personal_workspace()`, `resolve_public_form()`, `get_published_form()`, `register_form_slug()`, `resolve_form_session()`, and `purge_expired_sessions()`; that `app_user` can call each request function but cannot read the underlying tables directly; that `worker_user` can purge expired sessions but cannot select them directly; outbox INSERT-only for the request role without `RETURNING`; worker-role outbox access; append-only audit logs; rejection of an UPDATE that moves `workspace_id` to another tenant; rejection of cross-tenant composite foreign keys; the pooled-connection context-leak check; and the catalog guard for forced RLS, both policy clauses, and composite tenant keys. RLS is a database guarantee and cannot be proven through an API that might accidentally use a privileged connection.

There is no separate unit seam for the form-schema package in M0. Its validation behavior is exercised through the API seam. A pure logic-engine seam is added when M1/M2 introduces branching and variable evaluation.

Test infrastructure: Vitest for unit and API integration, Testcontainers Postgres for database tests, Playwright for the browser flow, and a Mailpit container or API for verification email. CI runs lint, typecheck, tests, and the E2E happy path. Coverage is not a target; tenant boundaries, the publish transaction, the submission transaction, and the public flow are.

Prior art: the new repository has no tests yet, so this spec establishes the seams. HeyForm's end-to-end permission-matrix suite is a behavioral reference for cross-tenant and role cases, not a code source.

## Out of Scope

M0 does not include:

- Conditional logic, branching, jumps, variables, calculations, answer piping, or a logic builder.
- Themes, custom CSS, fonts, branding controls, or theme presets beyond the default.
- The statement block and all other block types (choice, date, file, rating, etc.).
- Partial submissions, resume links, autosave of answers, or editing a submission after submit.
- File uploads, object storage, quotas, virus scanning, or image processing.
- Analytics, drop-off tracking, event dashboards, or exports (including CSV).
- Webhooks, integrations, Zapier/Make, email notifications, or delivery logs.
- Public API keys, API documentation for customers, or third-party API compatibility.
- Internationalization, translated form content, RTL, or localized emails beyond externalized strings.
- Custom domains, Cloudflare for SaaS, or wildcard subdomains.
- Embeddable forms or cross-origin postMessage flows.
- Payments, plan billing, Dodo integration, entitlements, or subscriptions.
- Workspace invitations, member management UI, role changes, ownership transfer, or multi-user collaboration.
- Google OAuth, TOTP, OIDC/SSO, SAML, or enterprise identity.
- Multiple projects UI, project renaming, moving forms between projects, duplication, templates, or folders.
- Collaborative editing, merge-based conflict resolution, version diff, rollback, or publish scheduling.
- Password-protected forms, captcha, spam scoring, or advanced rate limiting.
- Custom slug aliases, slug marketplace, or branded short links.
- Form deletion UI, submission deletion UI, audit-log UI, or workspace deletion UI.
- Data import from HeyForm, API compatibility, or visual clone parity.
- The full v1.0 scope. v1.0 is M4; M0 is only the walking skeleton.

## Further Notes

- The deployment spike must run before feature work. Verify the admin bootstrap and `fn_owner` policies, the supervisor's allowlisted child environments, GitHub Actions migrations before the Render deploy hook, the Next.js `/v1/*` rewrite, cookie flow through the single origin, internal SSR calls, and pg-boss against Neon's pooled and direct connections. If the single-service topology fails, fall back to two services or a single Next.js app and record the change.
- Docker is not installed in the current environment. The foundation slice starts by installing Docker or documenting and using an equivalent Postgres/Mailpit setup; local development and Testcontainers depend on it.
- The new repository is empty and has no `GLOSSARY.md` or ADRs yet. The spec uses the vocabulary established during planning: workspace, project, form, draft, published version, block, form session, submission, and public form. A glossary should be created when the first domain terms are finalized in code.
- Facts still to verify before their milestones: Dodo Payments' subscription, EU VAT, and webhook semantics; Resend's current free tier; Neon free-tier backup behavior; Render free-tier process and cold-start limits. None block M0's local work except the Neon/Render spike.
- The alpha's free-tier limitations are disposable. Do not encode cold-start or single-process assumptions into domain code, the RLS model, or the session design.
