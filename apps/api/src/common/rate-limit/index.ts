/**
 * Rate limiting (ticket 04 library portion; reused by ticket 10). Exports:
 *
 * - `RateLimiter` — in-memory fixed-window limiter, memory-bounded
 *   (`./rate-limiter` documents the semantics).
 * - `keyFor` — namespaced key builder (`"signin:email:user@example.com"`).
 * - The limit rules (single source of truth for ticket 04 wiring and ticket
 *   10): `SIGNUP_PER_HOUR_PER_IP`, `SIGNIN_PER_15MIN_PER_IP`,
 *   `SIGNIN_PER_15MIN_PER_EMAIL`, `RESET_PER_HOUR_PER_EMAIL`,
 *   `RESET_PER_HOUR_PER_IP`, `SESSION_PER_MINUTE_PER_IP`,
 *   `PUBLIC_SESSION_PER_HOUR_PER_IP`, `PUBLIC_SESSION_PER_HOUR_PER_FORM`,
 *   plus the `RATE_LIMIT_RULES` aggregate and `RateLimitRule` type.
 * - `rateLimited(retryAfterSec)` — the stable 429 Problem-Details body
 *   factory (`code: "rate_limited"`) with the `Retry-After` header value.
 * - `RateLimitModule` — self-contained Nest module; ticket 04 wiring
 *   registers it (AppModule is owned by ticket 03's worktree right now).
 */
export {
  DEFAULT_MAX_TRACKED_KEYS,
  keyFor,
  RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from "./rate-limiter";
export {
  PUBLIC_SESSION_PER_HOUR_PER_FORM,
  PUBLIC_SESSION_PER_HOUR_PER_IP,
  RATE_LIMITED_I18N_KEY,
  RATE_LIMITED_PROBLEM_TYPE,
  RATE_LIMIT_RULES,
  rateLimited,
  RESET_PER_HOUR_PER_EMAIL,
  RESET_PER_HOUR_PER_IP,
  type RateLimitedProblem,
  type RateLimitedResponse,
  type RateLimitRule,
  type RateLimitRuleName,
  SESSION_PER_MINUTE_PER_IP,
  SIGNIN_PER_15MIN_PER_EMAIL,
  SIGNIN_PER_15MIN_PER_IP,
  SIGNUP_PER_HOUR_PER_IP,
} from "./limits";
export { RateLimitModule } from "./rate-limit.module";
