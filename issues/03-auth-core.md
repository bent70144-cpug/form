# 03: Auth core and session boundary

**Spec:** `../spec.md`

**What to build:** Email/password signup, verification, sign-in/out, the minimal session endpoint, SSR session validation through the internal API, the protected dashboard shell, server-side revocation, the global Origin check for cookie-authenticated mutations, and the deployed email adapter with its sending-domain prerequisite.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Signup creates a Better Auth user; verification email uses Mailpit locally and an HTTPS email provider behind environment configuration in deployed environments. No console email adapter is used in deployed environments, and no verification token appears in logs; the verified state is reflected in the session.
- [ ] Signup and sign-in responses do not reveal whether an email exists. Signup with an existing address returns the same generic result as a new signup, and invalid sign-in returns one generic credential error.
- [ ] Passwords are 12–128 characters. The policy is enforced at signup and reset, and the limits are shared with ticket 04.
- [ ] Unverified users may sign in, but bootstrap, workspace, form, and submission-management routes reject them with 403 `email_unverified`; the dashboard shows a resend-verification prompt. No workspace is created until the email is verified.
- [ ] Development email uses the provider's sandbox, which may deliver only to the account owner's address. Before the first outside tester, a sending domain is owned and verified with the provider (roughly $10/year; confirm current pricing). The `onrender.com` hostname cannot serve as the verified sending domain.
- [ ] Sign-in and sign-out work. The session cookie is HttpOnly, Secure in production, SameSite=Lax, with a seven-day rolling expiry and server-side revocation.
- [ ] `GET /v1/auth/session` returns the user ID, email, verified flag, and the active workspace ID, name, and role when one exists; the workspace is null until ticket 05. The endpoint is read-only and never creates a workspace.
- [ ] Invalid or expired sessions return 401 with no body detail.
- [ ] Next.js server components validate the session through the internal API URL with the incoming cookie forwarded and wrap the call in React's `cache()`; browser calls use the same-origin `/v1/*` rewrite.
- [ ] The protected dashboard shell redirects signed-out visitors; a revoked session redirects on the next request; middleware only checks cookie presence.
- [ ] A global Nest guard enforces that all state-changing calls originate in the browser through the same-origin `/v1/*` rewrite: the `Origin` header must match the configured app origin, and missing or mismatched origins are rejected with a stable error code. There is no internal-call exemption. The only exemptions are an explicit cookie-less route allowlist for public session creation and submit, and an exempted route never reads the auth cookie. Better Auth's trusted origins are set to the app origin.
- [ ] Auth UI and auth error messages are looked up through i18n keys; no user-facing strings are hardcoded in components or controllers.
- [ ] The web app has no database URL or auth secret; the import and environment guards from ticket 01 still pass.
- [ ] Password reset and concrete auth rate limits are not part of this slice; they land in ticket 04.
- [ ] API integration and browser tests cover signup, verification, sign-in, sign-out, session expiry, revocation, enumeration-safe responses, the unverified-route rejection, and Origin rejection, including that a server-side bootstrap-shaped call without an `Origin` is rejected. The guard has tests for the allowlisted public routes and confirms they do not read the auth cookie.
