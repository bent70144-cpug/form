# ADR 0004 — Rate limiting and trusted client-IP derivation

**Status:** Accepted · **Ticket:** 04 (library portion) · **Date:** 2026-10-31

## Context

Ticket 04 hardens auth with password reset and concrete rate limits
(spec: "Auth endpoints are rate-limited … Exceeding a limit returns 429 with
stable `rate_limited`"). Rate limiting needs the real client IP, which the app
only learns through proxies: locally the NestJS API sits behind the Next.js
`/v1/*` rewrite (peer = `127.0.0.1`, ADR-0003), in the alpha behind the Render
platform edge. The spec requires: "It trusts only the platform's forwarded
client-IP header … and spoofed forwarded headers cannot change the derived
address. The limiter is in-memory for the single-process alpha and moves to
shared storage at beta."

This ADR records the library decisions for `apps/api/src/common/rate-limit/`
and `apps/api/src/common/trusted-ip/`. The endpoint wiring (middleware, guard
order, AppModule registration) is the rest of ticket 04 and was blocked by
ticket 03; ticket 10 reuses both libraries unchanged.

## Decisions

### 1. Trusted chain walk (right-to-left, count-based)

`deriveClientIp(req, config)` resolves the client IP from the socket peer plus
the forwarded header chain:

1. `peer = req.socket.remoteAddress`. With `trustedProxyCount === 0` the peer
   is **untrusted**: every forwarded header is ignored and the derived IP is
   the peer itself — this is the spoof-proof local default (the Next rewrite
   peer is `127.0.0.1`; a client-sent `X-Forwarded-For` cannot move it).
2. With `trustedProxyCount >= 1` the peer is trusted hop #1, and each step
   LEFT through the configured header chain (`x-forwarded-for` by default)
   consumes one more trusted hop. The walk stops after `trustedProxyCount`
   hops, so only the rightmost N entries — values honest proxies appended —
   can influence the result; spoofed entries further left are discarded.
3. Chain entries that are not valid IP literals are skipped **without**
   consuming a trusted hop: honest proxies only append real addresses, and
   garbage must not mint fresh rate-limit buckets (defeats key-rotation
   flooding with `<garbage>` values).
4. If the chain runs out before the hops do, the walk lands on the leftmost
   attested address (or the peer when no header is present — e.g. server
   components calling the internal API port directly).

`TRUSTED_PROXY_COUNT` **must match the real topology**: each excess hop
shifts the derivation one valid entry further left (the same trade-off as
Express's count-based `trust proxy`; covered by a test that pins the behavior
as a documented limitation). Under-counting is safe — it attributes traffic to
the nearest trusted proxy instead of the client.

### 2. Configuration and deployment defaults

- `TRUSTED_PROXY_COUNT` (Zod-validated int 0–64): explicit wins. Default: **1
  on Render** (detected via `RENDER=true` / `RENDER_SERVICE_ID` — the platform
  edge is the trusted peer in front of the Next process), **0 elsewhere**
  (local dev, loopback peer).
- `TRUSTED_PROXY_HEADERS` (comma-separated, priority order): defaults to
  `x-forwarded-for` (Render's attestation header). The first configured header
  that carries a valid IP entry wins; later headers are ignored. When
  Cloudflare arrives (beta): `TRUSTED_PROXY_HEADERS="cf-connecting-ip,x-forwarded-for"`
  and `TRUSTED_PROXY_COUNT=2` (edge + platform hop).
- **Ownership deviation:** the env schema lives in
  `common/trusted-ip/config.ts` (`loadTrustedIpConfig`, error style mirrors
  `@form/config`'s `loadEnv`) because `apps/api/src/env.ts` is owned by the
  ticket-03 worktree. Ticket 04's wiring merges the two variables into the
  main API env schema and deletes the module-local loader.

### 3. The Next.js header contract (ticket 04 wiring)

Browser → Render edge → Next.js → `/v1/*` rewrite → NestJS:

- The Render edge attests the client IP in `X-Forwarded-For` (append
  semantics: spoofed client values survive only LEFT of the edge's honest
  append, where the walk never looks with a correct count).
- Next.js must **pass forwarding headers through the rewrite unchanged** — no
  stripping, no rewriting of `x-forwarded-for`. Next is a pass-through hop on
  the same host; the trusted chain reads the edge's value.
- Locally there is no platform proxy: NestJS's peer is the Next process
  (`127.0.0.1`), 0 proxies are trusted, and derivation ignores headers (the
  documented ADR-0003 spike observation).
- Server components call the internal API port directly (not through the
  rewrite) and derive the loopback address — expected; wiring may exempt the
  internal hop from IP limits or rely on the shared loopback bucket (120/min
  session limit applies per IP, so SSR bursts share one bucket; watch it in
  wiring tests).

### 4. In-memory fixed-window limiter (alpha) → shared storage (beta)

`RateLimiter.check(key, limit, windowMs)` is a **fixed-window** counter with
lazy expiry (`{ count, windowStart, windowMs }` per key; a check past
`windowStart + windowMs` starts a fresh window in place; no timers). Semantics:

- The Nth attempt of an N-limit window is `ok` with `remaining: 0`; the N+1th
  is `{ ok: false, retryAfterSec }` (seconds until reset, min 1 — the
  `Retry-After` value).
- **Rejected attempts count** against the current window (re-checking cannot
  sneak past the limit and cannot extend the window — it resets on schedule).
- **Memory-bounded:** keys are capped (`DEFAULT_MAX_TRACKED_KEYS = 50,000`,
  a few MB worst case on the 3.6 GB free-tier box). At capacity the limiter
  prunes expired windows, then evicts soonest-expiring survivors (deterministic
  O(n) scan in the saturated case). Key-rotation attacks can evict other
  clients' windows early (bounded availability trade-off) but can never grow
  the process or exceed the cap.
- `keyFor(parts)` joins with `:` and drops empty parts, so scope namespaces
  (`signin:ip:…` vs `signin:email:…`) never collide even when values are empty.
- **Single process only** — the alpha is one web service; horizontal replicas
  (beta) would each keep private windows. The beta move to shared storage
  (e.g. Redis/Postgres-backed token bucket keyed the same way) must preserve
  the `check()` contract and `keyFor()` namespacing so call sites don't change.

### 5. The 429 contract

`rateLimited(retryAfterSec)` produces:

- Body: RFC 9457 Problem Details — `{ type: "https://form.example/errors/rate_limited",
  title: "Too Many Requests", status: 429, code: "rate_limited", detail }`,
  structurally identical to `@form/contracts`' `ProblemDetails` (that package
  is not an API dependency yet; wiring may swap the type import).
- `detail` is the i18n key `errors.rateLimited.title` (repo convention: API
  messages reference keys; enumeration-safe and locale-safe).
- `retryAfterSec` → the `Retry-After` header (stringified seconds).

Wiring shape:

```ts
const result = limiter.check(keyFor(["signup", "ip", clientIp]), SIGNUP_PER_HOUR_PER_IP.limit, SIGNUP_PER_HOUR_PER_IP.windowMs);
if (!result.ok) {
  const { problem, retryAfterSec } = rateLimited(result.retryAfterSec);
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).contentType("application/problem+json").json(problem);
}
```

### 6. Limit constants (single source of truth)

`common/rate-limit/limits.ts` (also re-exported from `common/rate-limit`):

| Constant | limit | window |
| --- | --- | --- |
| `SIGNUP_PER_HOUR_PER_IP` | 5 | 1 h |
| `SIGNIN_PER_15MIN_PER_IP` | 10 | 15 min |
| `SIGNIN_PER_15MIN_PER_EMAIL` | 10 | 15 min |
| `RESET_PER_HOUR_PER_EMAIL` | 3 | 1 h |
| `RESET_PER_HOUR_PER_IP` | 10 | 1 h |
| `SESSION_PER_MINUTE_PER_IP` | 120 | 1 min |
| `PUBLIC_SESSION_PER_HOUR_PER_IP` (ticket 10) | 30 | 1 h |
| `PUBLIC_SESSION_PER_HOUR_PER_FORM` (ticket 10) | 30 | 1 h |

## Reuse and wiring notes

- **Ticket 04 wiring:** register `RateLimitModule` (self-contained, `@Global`,
  exports `RateLimiter`), load `loadTrustedIpConfig()` at startup, derive the
  client IP once per request, and apply the rules above to signup / sign-in /
  reset / session routes. The supertest end-to-end hop test (browser → rewrite
  → NestJS, asserting the derived IP and 429s) belongs to that slice — the
  unit tests here cover the algorithm against the ADR-0003 hop shapes with
  fake requests (no server needed).
- **Ticket 10:** `deriveClientIp` + `RateLimiter` + the two
  `PUBLIC_SESSION_*` rules are directly reusable; no library changes expected.
- **Email limits:** email-keyed rules use the normalized address as key part;
  keep the normalization (lowercasing) in wiring, not in the limiter.

## Consequences

- Spoofed forwarded headers cannot change the derived IP under correct
  configuration; the security property is unit-tested (untrusted peer ignores
  headers; trusted chain discards left-of-chain spoofed entries).
- The limiter is per-process by design; beta must move it to shared storage
  before running more than one API replica.
- `TRUSTED_PROXY_COUNT` is load-bearing configuration — wrong values shift or
  over-trust the derivation; the deploy runbook must set it explicitly on
  Render (the env default only covers the standard single-proxy topology).
- Rate-limit tests run without a database (pure in-memory + fake timers), so
  they stay fast and independent of the embedded-Postgres fixture.

## Wiring notes (ticket 04 endpoint wiring — landed)

The endpoint wiring was implemented in `apps/api` after ticket 03 landed:

- **Placement.** `createApiApp` registers the guard as Express middleware in
  this order: `originGuard` → `express.json()` (first-pass body parse) →
  `hopDiagnostics` (non-production) → `createRateLimitGuard` → the Better Auth
  mount → the Nest router. The Origin check therefore still runs first (a
  cross-site request cannot consume limiter slots, so per-email buckets cannot
  be exhausted by originless noise), and a 429 never reaches Better Auth or
  Nest. A Nest interceptor would not cover the auth routes at all — they are
  handled by the mounted Better Auth handler, which bypasses the Nest router.
- **`express.json()` before the mount.** The guard needs the sign-in /
  reset-request body to key the per-email dimension. Better Auth's node
  adapter (`better-call` `getRequest`) transparently re-serializes an
  already-parsed `req.body` when the raw stream is consumed, so the early
  parse does not disturb the mount (verified against better-call 1.4.4).
  Limit: 64 KB.
- **Env schema merged.** `TRUSTED_PROXY_COUNT` / `TRUSTED_PROXY_HEADERS` moved
  into `apps/api/src/env.ts` (Zod-validated, fails at startup) and are mapped
  to `TrustedIpConfig` by `trustedIpConfigFromValues` in
  `common/trusted-ip/config.ts`. The module-local `loadTrustedIpConfig`
  REMAINS as the env-record entry point (it is the tested library surface that
  ticket 10 reuses); `env.ts` duplicates only the two field validators so a
  bad value fails API boot with the standard API-env error shape. (Amends the
  "deletes the module-local loader" note above — the loader stays; the
  validation contract is enforced on both layers.)
- **Route/limits wiring** (`RATE_LIMITED_ROUTES` in
  `common/rate-limit/wire.ts`): `POST /v1/auth/sign-up/email` →
  SIGNUP_PER_HOUR_PER_IP; `POST /v1/auth/sign-in/email` → per-IP
  SIGNIN_PER_15MIN_PER_IP then per-email SIGNIN_PER_15MIN_PER_EMAIL (IP gate
  first so an exhausted IP bucket never consumes per-email slots);
  `POST /v1/auth/request-password-reset` → per-email RESET_PER_HOUR_PER_EMAIL
  (tighter limit first) then per-IP RESET_PER_HOUR_PER_IP; `GET
  /v1/auth/session` → SESSION_PER_MINUTE_PER_IP. Better Auth's
  `/request-password-reset` is the same endpoint as `/forget-password`
  (spec'd "reset request"); `/reset-password` completion is NOT limited (the
  single-use token is the brute-force control there).
- **Key namespaces:** `signup:ip:<ip>`, `signin:ip:<ip>`,
  `signin:email:<email>`, `reset:email:<email>`, `reset:ip:<ip>`,
  `session:ip:<ip>` via `keyFor`; emails normalized (trim + lowercase) in the
  guard, IPs via `deriveClientIp`/`normalizeIp`.
- **Test isolation:** the shared auth fixture disables the guard
  (`rateLimits: { enabled: false }`) so pre-existing suites keep their
  request budgets; the spec limits are exercised end-to-end by
  `test/auth-rate-limit.test.ts` (per-route boundaries, per-IP vs per-email
  independence, Retry-After decay, spoof rotation) and
  `test/trusted-ip-rewrite.test.ts` — the real browser → `next dev` `/v1/*`
  rewrite → NestJS hop with `TRUSTED_PROXY_COUNT` 0 and 1 phases asserting
  what Nest derives (non-production `x-derived-client-ip` hop diagnostics)
  and that spoofed forwarded headers cannot change it.
- **Password reset flow:** Better Auth `emailAndPassword` with
  `sendResetPassword` (through the shared `EmailProvider` port — mail sink
  locally), `resetPasswordTokenExpiresIn: 3600` (single-use:
  `consumeVerificationValue` deletes the `reset-password:<token>` row on
  first redemption), `revokeSessionsOnPasswordReset: true`, and the shared
  12–128 password policy. The request endpoint answers the same generic
  `{ status: true, message }` body for known and unknown addresses (Better
  Auth hashes a dummy lookup on miss); the UI renders ONE shared i18n key
  (`auth.enumerationSafeResponse`). Coverage:
  `apps/api/test/auth-reset.test.ts`.
