/**
 * Auth + public-session rate limits — the single source of truth for ticket
 * 04's endpoint wiring and ticket 10's public session/submit endpoints
 * (spec: "Signup allows 5 attempts per hour per IP; sign-in allows 10
 * attempts per 15 minutes per IP and per email; reset requests allow 3 per
 * hour per email and 10 per hour per IP; the session endpoint allows 120
 * requests per minute per IP").
 *
 * Each rule is `{ limit, windowMs }` and feeds `RateLimiter.check` directly.
 * Wiring keys rules with `keyFor`, e.g.:
 *
 *   keyFor(["signup", "ip", clientIp])                 // SIGNUP_PER_HOUR_PER_IP
 *   keyFor(["signin", "email", normalizedEmail])       // SIGNIN_PER_15MIN_PER_EMAIL
 *   keyFor(["public-session", "form", formId])         // PUBLIC_SESSION_PER_HOUR_PER_FORM
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const FIFTEEN_MINUTES_MS = 900_000;

/** Signup: 5 attempts per hour per client IP. */
export const SIGNUP_PER_HOUR_PER_IP: RateLimitRule = { limit: 5, windowMs: HOUR_MS };

/** Sign-in: 10 attempts per 15 minutes per client IP. */
export const SIGNIN_PER_15MIN_PER_IP: RateLimitRule = { limit: 10, windowMs: FIFTEEN_MINUTES_MS };

/** Sign-in: 10 attempts per 15 minutes per email address (normalized). */
export const SIGNIN_PER_15MIN_PER_EMAIL: RateLimitRule = {
  limit: 10,
  windowMs: FIFTEEN_MINUTES_MS,
};

/** Password-reset request: 3 per hour per email address (normalized). */
export const RESET_PER_HOUR_PER_EMAIL: RateLimitRule = { limit: 3, windowMs: HOUR_MS };

/** Password-reset request: 10 per hour per client IP. */
export const RESET_PER_HOUR_PER_IP: RateLimitRule = { limit: 10, windowMs: HOUR_MS };

/** Authenticated session endpoint (`GET /v1/auth/session`): 120 req/min per IP. */
export const SESSION_PER_MINUTE_PER_IP: RateLimitRule = { limit: 120, windowMs: MINUTE_MS };

/** Ticket 10 — public session creation: 30 per hour per client IP. */
export const PUBLIC_SESSION_PER_HOUR_PER_IP: RateLimitRule = { limit: 30, windowMs: HOUR_MS };

/** Ticket 10 — public session creation: 30 per hour per form. */
export const PUBLIC_SESSION_PER_HOUR_PER_FORM: RateLimitRule = { limit: 30, windowMs: HOUR_MS };

/** All rules, keyed by stable wiring name (convenience for middleware loops). */
export const RATE_LIMIT_RULES = {
  SIGNUP_PER_HOUR_PER_IP,
  SIGNIN_PER_15MIN_PER_IP,
  SIGNIN_PER_15MIN_PER_EMAIL,
  RESET_PER_HOUR_PER_EMAIL,
  RESET_PER_HOUR_PER_IP,
  SESSION_PER_MINUTE_PER_IP,
  PUBLIC_SESSION_PER_HOUR_PER_IP,
  PUBLIC_SESSION_PER_HOUR_PER_FORM,
} as const;

export type RateLimitRuleName = keyof typeof RATE_LIMIT_RULES;

/**
 * i18n key referenced by the 429 problem body (repo convention: "API error
 * messages resolve titles/details by key, never hardcoded" — see
 * `packages/i18n` `errors.rateLimited.title`).
 */
export const RATE_LIMITED_I18N_KEY = "errors.rateLimited.title";

/** Problem `type` slug for rate limiting (RFC 9457, matches contracts). */
export const RATE_LIMITED_PROBLEM_TYPE = "https://form.example/errors/rate_limited";

/**
 * RFC 9457 Problem Details body for a 429 — structurally identical to the
 * `ProblemDetails` schema in `@form/contracts` (that package is not an API
 * dependency yet; ticket 04 wiring may swap the type import). The `detail`
 * carries the i18n key so clients localize user-facing copy.
 */
export interface RateLimitedProblem {
  type: string;
  title: string;
  status: 429;
  code: "rate_limited";
  detail: string;
}

/** Factory result: the 429 body plus the `Retry-After` header value (seconds). */
export interface RateLimitedResponse {
  problem: RateLimitedProblem;
  /** Seconds until the limiter window resets — the `Retry-After` header value. */
  retryAfterSec: number;
}

/**
 * Builds the stable 429 response for an exhausted limit. `retryAfterSec` comes
 * from the rejecting `RateLimiter.check` result (`{ ok: false }` branch).
 *
 *   const result = limiter.check(key, rule.limit, rule.windowMs);
 *   if (!result.ok) {
 *     const { problem, retryAfterSec } = rateLimited(result.retryAfterSec);
 *     res.setHeader("Retry-After", String(retryAfterSec));
 *     res.status(429).contentType("application/problem+json").json(problem);
 *   }
 */
export function rateLimited(retryAfterSec: number): RateLimitedResponse {
  return {
    problem: {
      type: RATE_LIMITED_PROBLEM_TYPE,
      title: "Too Many Requests",
      status: 429,
      code: "rate_limited",
      detail: RATE_LIMITED_I18N_KEY,
    },
    retryAfterSec: Math.max(1, Math.ceil(retryAfterSec)),
  };
}
