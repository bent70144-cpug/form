import type { NextFunction, Request, RequestHandler, Response } from "express";
import { deriveClientIp, type TrustedIpConfig } from "../trusted-ip";
import {
  keyFor,
  rateLimited,
  RESET_PER_HOUR_PER_EMAIL,
  RESET_PER_HOUR_PER_IP,
  SESSION_PER_MINUTE_PER_IP,
  SIGNIN_PER_15MIN_PER_EMAIL,
  SIGNIN_PER_15MIN_PER_IP,
  SIGNUP_PER_HOUR_PER_IP,
  type RateLimitRule,
} from "./limits";
import type { RateLimiter } from "./rate-limiter";

/**
 * Ticket 04 wiring — applies the spec's auth rate limits to the exact routes
 * (docs/adr/0004-rate-limiting.md §6):
 *
 *   POST /v1/auth/sign-up/email     → 5 / hour  per IP
 *   POST /v1/auth/sign-in/email     → 10 / 15min per IP AND per email
 *   POST /v1/auth/forget-password   → 3 / hour  per email, 10 / hour per IP
 *   GET  /v1/auth/session           → 120 / min per IP
 *
 * The middleware runs as Express middleware (NOT a Nest interceptor) because
 * the auth routes live on the Better Auth mount, which bypasses the Nest
 * router entirely. Order in createApiApp: originGuard → THIS → mountBetterAuth
 * → Nest router, so only requests that passed the Origin check consume
 * limiter slots (cross-site noise cannot exhaust a victim's per-email bucket)
 * and a 429 never reaches Better Auth.
 *
 * The client IP is derived with `deriveClientIp` + `loadTrustedIpConfig`
 * (trusted-proxy chain walk) — a spoofed `X-Forwarded-For` cannot change the
 * derived address, so it cannot bypass or rotate IP buckets.
 *
 * Per-email keys normalize the address (lowercase + trim) — "A@X.com" and
 * "a@x.com" share one bucket (ADR-0004: normalization lives in wiring, not in
 * the limiter). When the body is not a parsed JSON object with a string email
 * the email key is skipped and only the IP key applies; Better Auth rejects
 * the malformed body anyway.
 */

/** Extracts the email field from an already-parsed JSON body, if any. */
function bodyEmail(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)["email"];
}

/**
 * Normalizes an email for rate-limit keys: trim + lowercase. Returns null for
 * non-string/empty values (no email key for that request).
 */
export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** One matched (key, rule) pair for a request. */
export interface MatchedRateLimit {
  key: string;
  rule: RateLimitRule;
}

/** Extracts the pathname from a request without decoding/search complexity. */
function pathnameOf(req: Request): string {
  return (req.originalUrl ?? req.url ?? "/").split("?")[0] ?? "/";
}

/**
 * Pure route → keys matcher (unit-testable without a server). Returns the
 * rules to check IN ORDER; the first exhausted key wins the 429.
 */
export function authRateLimitKeys(
  method: string,
  pathname: string,
  body: unknown,
  clientIp: string | null,
): MatchedRateLimit[] {
  if (clientIp === null) return []; // no derivable peer — nothing to key on

  if (method === "POST" && pathname === "/v1/auth/sign-up/email") {
    return [{ key: keyFor(["signup", "ip", clientIp]), rule: SIGNUP_PER_HOUR_PER_IP }];
  }

  if (method === "POST" && pathname === "/v1/auth/sign-in/email") {
    const keys: MatchedRateLimit[] = [
      { key: keyFor(["signin", "ip", clientIp]), rule: SIGNIN_PER_15MIN_PER_IP },
    ];
    const email = normalizeEmail(bodyEmail(body));
    if (email !== null) {
      keys.push({ key: keyFor(["signin", "email", email]), rule: SIGNIN_PER_15MIN_PER_EMAIL });
    }
    return keys;
  }

  if (method === "POST" && pathname === "/v1/auth/forget-password") {
    const keys: MatchedRateLimit[] = [];
    const email = normalizeEmail(bodyEmail(body));
    if (email !== null) {
      keys.push({ key: keyFor(["reset", "email", email]), rule: RESET_PER_HOUR_PER_EMAIL });
    }
    keys.push({ key: keyFor(["reset", "ip", clientIp]), rule: RESET_PER_HOUR_PER_IP });
    return keys;
  }

  if (method === "GET" && pathname === "/v1/auth/session") {
    return [{ key: keyFor(["session", "ip", clientIp]), rule: SESSION_PER_MINUTE_PER_IP }];
  }

  return [];
}

export interface AuthRateLimiterOptions {
  /** The process-local limiter (provided by RateLimitModule). */
  limiter: RateLimiter;
  /** Trusted-proxy config from `loadTrustedIpConfig` (env-validated at boot). */
  trustedIp: TrustedIpConfig;
}

/**
 * Builds the global auth rate-limit middleware. Over-limit requests get the
 * stable 429 Problem-Details body from `rateLimited()` plus a `Retry-After`
 * header (seconds until the window resets), and never reach Better Auth or
 * the Nest router. Rejected attempts still consume a slot of the current
 * window (RateLimiter semantics — re-checking cannot sneak past the limit).
 */
export function createAuthRateLimiter(options: AuthRateLimiterOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = deriveClientIp(
      { socket: req.socket, headers: req.headers },
      options.trustedIp,
    );
    const matched = authRateLimitKeys(req.method, pathnameOf(req), req.body, clientIp);
    for (const { key, rule } of matched) {
      const result = options.limiter.check(key, rule.limit, rule.windowMs);
      if (!result.ok) {
        const { problem, retryAfterSec } = rateLimited(result.retryAfterSec);
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).type("application/problem+json").json(problem);
        return; // do NOT call next() — a limited request never proceeds
      }
    }
    next();
  };
}
