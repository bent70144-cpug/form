# 04: Auth hardening — password reset and rate limits

**Spec:** `../spec.md`

**What to build:** The password-reset flow and concrete authentication rate limits. This slice must land before the deployed M0 smoke test. It does not gate tickets 05–09, but ticket 10 depends on the trusted-client-IP derivation and limiter built here.

**Blocked by:** 03

**Status:** done

- [x] A user can request a password reset and complete it through an emailed single-use token that expires after one hour. The reset response is generic whether or not the address exists.
- [x] Completing a password reset revokes all of the user's existing sessions. The new password follows the 12–128 character policy from ticket 03.
- [x] Signup is limited to 5 attempts per hour per IP. Sign-in is limited to 10 attempts per 15 minutes per IP and per email. Password-reset requests are limited to 3 per hour per email and 10 per hour per IP. The session endpoint is limited to 120 requests per minute per IP. Exceeding a limit returns 429 with stable `rate_limited`.
- [x] Rate limiting derives the client IP from the trusted proxy chain (Render now, Cloudflare when added) and ignores spoofed forwarded headers. Tests exercise the actual browser → Next.js `/v1/*` rewrite → NestJS hop, assert what Nest sees as the peer address, and verify that spoofed forwarded headers cannot change the derived client IP.
- [x] The limiter is in-memory for the single-process alpha; moving it to shared storage is a beta task. Ticket 10 reuses this trusted-IP derivation and limiter.
- [x] Auth error messages use i18n keys, and enumeration-safe responses share the same key.
- [x] Rate-limit behavior is covered by API tests, including the reset path and session revocation after reset.
- [x] The Origin check and session boundary from ticket 03 are unchanged.
- [x] This slice must be complete before ticket 12.

## Implementation notes (2026-10-31)

- Password reset e2e through the mail sink: single-use token, 1-hour expiry, all-session revocation on completion, generic unknown-email response. 
- Rate limits (signup 5/h/IP; sign-in 10/15min IP+email; reset 3/h/email + 10/h/IP; session 120/min/IP) → 429 `rate_limited`, exercised over the real browser→Next rewrite→Nest hop with trusted-proxy IP derivation and spoof immunity tests (ADR-0004). In-memory limiter for alpha; shared-storage move documented for beta.
- Completed before ticket 12 as required; Origin check and session boundary unchanged.
