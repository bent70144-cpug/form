# 10: Pinned public sessions and submissions

**Spec:** `../spec.md`

**What to build:** The interactive public form: create a pinned session, validate answers server-side, store one idempotent submission per session, show the ending, and handle expiry, closed, and capacity states.

**Blocked by:** 04, 09

**Status:** ready-for-agent

- [ ] Public session creation resolves the form through `resolve_public_form(slug)`, the session-creation function distinct from the render-only `get_published_form(slug)`; public submit resolves it through `resolve_form_session(token_hash)`. Both set `app.workspace_id` from the resolved form, never from the client. A forged workspace ID or header is ignored and tested.
- [ ] `resolve_public_form()`, `resolve_form_session()`, and `purge_expired_sessions()` run as `fn_owner` with explicit `TO fn_owner` policies on `forms`, `form_versions`, `form_slugs`, and `form_sessions`; `app_user` can execute the public functions but cannot read `form_sessions` directly. `purge_expired_sessions()` is the worker's only cross-tenant cleanup path: it is owned by `fn_owner`, executes as a security-definer function, and is granted only to `worker_user`. A test confirms `worker_user` can purge but cannot select sessions directly.
- [ ] Session creation returns the raw token once and stores only its hash; the session pins the published version and has an expiry.
- [ ] `resolve_form_session(token_hash)` resolves the session to its form, pinned version, and expiry state.
- [ ] A session is usable for 24 hours; submissions are accepted for a five-minute grace window after expiry; expired sessions are cleaned up after seven days.
- [ ] Session creation is limited to 30 requests per hour per IP and per form; the limiter uses the trusted client IP from the proxy chain (Render/Cloudflare), not a spoofable header. Tests exercise the actual browser → Next.js `/v1/*` rewrite → NestJS hop, assert what Nest sees as the peer address, and verify that spoofed forwarded headers cannot change the derived client IP.
- [ ] Stored IP metadata is an HMAC of the address with a server secret, not a reversible hash.
- [ ] The read-only public page from ticket 09 becomes interactive: it creates a session, collects answers, validates required questions, and submits. Public session creation and submit are on the explicit cookie-less route allowlist; an exempted route never reads the auth cookie.
- [ ] Server validation rejects unknown block IDs, answers to non-question blocks, missing required answers, over-limit values, NUL (`\u0000`) characters with `invalid_character`, and oversized payloads with stable error codes. Whitespace-only text counts as empty for a required question.
- [ ] Per-answer limits are 1,000 characters for short-text and 10,000 for long-text; the submission JSON cap is 100 KB by bytes; the submit route body limit is about 150 KB; the JSON cap governs when per-field maxima would exceed it.
- [ ] A configurable per-form submission cap (default 1,000 for the alpha) is enforced transactionally with the form row locked and returns 409 `form_full` when reached, so a public form cannot exhaust the free database.
- [ ] Submission idempotency is session-scoped: `form_session_id` is unique, so each session has at most one submission. A retry returns a receipt (`submitted: true` plus submission ID) without stored answers; the loser of a concurrent double-submit race returns the same receipt. The session is marked completed.
- [ ] If a newer version is published mid-session, the pinned version may submit within the session window; an unpublished, closed, or soft-deleted form rejects submission.
- [ ] At 360px CSS width the form has no horizontal scrolling; a Playwright viewport test checks it, and every input has a programmatically associated label and error message.
- [ ] Session and submission UI strings, validation messages, and errors use i18n keys.
- [ ] `submission.created` is audited and emitted to the outbox; session and submission tables have forced RLS, both policy clauses, composite tenant keys, and cross-tenant tests.
- [ ] The dashboard inbox is not implemented in this slice.
