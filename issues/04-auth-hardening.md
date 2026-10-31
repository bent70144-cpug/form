# 04: Auth hardening — password reset and rate limits

**Spec:** `../spec.md`

**What to build:** The password-reset flow and concrete authentication rate limits. This slice must land before the deployed M0 smoke test. It does not gate tickets 05–09, but ticket 10 depends on the trusted-client-IP derivation and limiter built here.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A user can request a password reset and complete it through an emailed single-use token that expires after one hour. The reset response is generic whether or not the address exists.
- [ ] Completing a password reset revokes all of the user's existing sessions. The new password follows the 12–128 character policy from ticket 03.
- [ ] Signup is limited to 5 attempts per hour per IP. Sign-in is limited to 10 attempts per 15 minutes per IP and per email. Password-reset requests are limited to 3 per hour per email and 10 per hour per IP. The session endpoint is limited to 120 requests per minute per IP. Exceeding a limit returns 429 with stable `rate_limited`.
- [ ] Rate limiting derives the client IP from the trusted proxy chain (Render now, Cloudflare when added) and ignores spoofed forwarded headers. Tests exercise the actual browser → Next.js `/v1/*` rewrite → NestJS hop, assert what Nest sees as the peer address, and verify that spoofed forwarded headers cannot change the derived client IP.
- [ ] The limiter is in-memory for the single-process alpha; moving it to shared storage is a beta task. Ticket 10 reuses this trusted-IP derivation and limiter.
- [ ] Auth error messages use i18n keys, and enumeration-safe responses share the same key.
- [ ] Rate-limit behavior is covered by API tests, including the reset path and session revocation after reset.
- [ ] The Origin check and session boundary from ticket 03 are unchanged.
- [ ] This slice must be complete before ticket 12.
