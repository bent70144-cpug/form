# 09: Publish immutable versions and serve the read-only public form

**Spec:** `../spec.md`

**What to build:** Atomic publish with immutable versions, slug allocation and redirects, unpublish and closed behavior, draft isolation, dashboard publish controls, and a server-rendered read-only public page that calls an unauthenticated public API wrapping the published-snapshot function.

**Blocked by:** 08

**Status:** done

- [x] The form page has Publish, Republish, and Unpublish controls, shows the current status and published version number, and offers a copy-link action. A publish-time warning appears when the worst-case answer size, using each question kind's own cap, would exceed the submission cap.
- [x] Publish re-runs the full schema validation from ticket 07: unique block IDs, supported kinds, non-empty labels or titles, block limits, at least one question block, at most one welcome and one ending block, a welcome block first if present, and an ending block last if present; it creates an immutable published version and sets the form status to `published`.
- [x] Republishing creates a new immutable version; editing the draft after publish does not change the published page.
- [x] The first publish allocates a 10-character base62 slug through `register_form_slug`; reserved words are rejected; old slugs redirect through the registry.
- [x] Old-slug redirect behavior is tested directly through the registry and API seam; the public API returns a `redirect` status with the canonical slug, and M0 has no rename UI.
- [x] Unpublish sets the form status to `closed`; republish reopens it. A closed or soft-deleted form shows the closed message, while a missing slug returns 404.
- [x] An unauthenticated `GET /v1/public/forms/{slug}` wraps `get_published_form(slug)`, which returns the snapshot plus a status: `published`, `closed`, `redirect` with the canonical slug, or `not_found`. The endpoint returns 200 for `published` and `closed`, 308 with `Location: /f/{canonical_slug}` for `redirect`, and 404 for `not_found`. Next.js SSR calls it over the internal API URL because the web app has no database access. `/f/{slug}` renders welcome, question, and ending blocks without creating a session.
- [x] The public API response and the SSR page send `Cache-Control: no-store` in M0, so unpublish and republish take effect immediately without a purge story.
- [x] `get_published_form(slug)` is the render path and returns the snapshot. `resolve_public_form(slug)` from ticket 10 is the separate session-creation path that returns IDs and pinning metadata. Neither function returns drafts.
- [x] `get_published_form()` and `register_form_slug()` run as `fn_owner` with explicit `TO fn_owner` policies on `forms`, `form_versions`, and `form_slugs`; `app_user` can execute the functions but cannot read the slug registry directly.
- [x] The public page is `noindex`; the future password gate will sit in front of the same public API endpoint.
- [x] Labels, descriptions, titles, and placeholders render as escaped text, never as HTML. A test publishes a label containing `<script>` and confirms it appears as text and does not execute.
- [x] Publishing is one transaction: lock the form row, validate the draft, allocate the next version number, insert the immutable version, update the published pointer and status, register or update the slug, insert the audit entry, and insert the `form.published` outbox event. An injected failure rolls back all of it, and concurrent publishes serialize on the form row.
- [x] `form.published` and `form.unpublished` are audited and emitted to the outbox; `form_versions` and `form_slugs` have forced RLS, both policy clauses, composite tenant keys, and cross-tenant tests.
- [x] All publish controls, status text, warnings, and errors use i18n keys.
- [x] Browser tests cover Publish, Republish, Unpublish, status, copy-link, version number, the worst-case warning, and the public closed message.
- [x] Session creation and submission are not implemented in this slice.

## Implementation notes (2026-10-31)

- Atomic publish transaction: lock form row, full schema re-validation, immutable `form_versions` insert, published pointer + status, slug registry via `register_form_slug` (10-char base62, reserved words rejected), audit + `form.published` outbox — injected-failure rollback and concurrent-publish serialization tested. Republish creates new versions; draft edits never affect the published page; unpublish -> `closed` with closed-message rendering; old slugs redirect (308 with canonical slug) via the registry.
- `GET /v1/public/forms/{slug}` wraps `get_published_form` (published/closed/redirect/not_found; 200/200/308/404) with `Cache-Control: no-store`; SSR renders over the internal API URL, escaped text only (script-tag label test passes), `noindex`. fn_owner policies on forms/versions/slugs; app_user cannot read the registry directly. API 173/173 at merge.
