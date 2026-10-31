import type { NextFunction, Request, RequestHandler, Response } from "express";
import { t } from "@form/i18n";
import { deriveClientIp, type TrustedIpConfig } from "../trusted-ip";
import {
  keyFor,
  RATE_LIMITED_I18N_KEY,
  type RateLimitRule,
  RATE_LIMIT_RULES,
  rateLimited,
  type RateLimiter,
  RESET_PER_HOUR_PER_EMAIL,
  RESET_PER_HOUR_PER_IP,
  SESSION_PER_MINUTE_PER_IP,
  SIGNIN_PER_15MIN_PER_EMAIL,
  SIGNIN_PER_15MIN_PER_IP,
  SIGNUP_PER_HOUR_PER_IP,
} from "./index";

/**
 * Ticket 04 endpoint wiring — applies the spec's auth rate limits to the REAL
 * routes (spec: "Signup allows 5 attempts per hour per IP; sign-in allows 10
 * attempts per 15 minutes per IP and per email; reset requests allow 3 per
 * hour per email and 10 per hour per IP; the session endpoint allows 120
 * requests per minute per IP. Exceeding a limit returns 429 with stable
 * `rate_limited`").
 *
 * Placement: the guard runs AFTER the global Origin guard and a first-pass
 * `express.json()` body parse (so the sign-in / reset-request bodies can key
 * the per-email dimensions), and BEFORE the Better Auth mount and the Nest
 * router. Better Auth's node adapter (`better-call`) transparently re-uses an
 * already-parsed `req.body` when the raw stream is consumed, so the early
 * parse does not disturb the mount.
 *
 * Keys (ADR-0004): the client IP comes from `deriveClientIp` (trusted proxy
 * chain — spoofed forwarded headers cannot change it) and email addresses are
 * normalized (trim + lowercase) before keying, so `User@Example.com` and
 * `user@example.com` share one bucket.
 */

/** The exact mounted Better Auth / Nest routes covered by auth limits. */
export const RATE_LIMITED_ROUTES = {
  signUpIp: { method: "POST", path: "/v1/auth/sign-up/email" },
  signInIp: { method: "POST", path: "/v1/auth/sign-in/email" },
  signInEmail: { method: "POST", path: "/v1/auth/sign-in/email" },
  resetEmail: { method: "POST", path: "/v1/auth/request-password-reset" },
  resetIp: { method: "POST", path: "/v1/auth/request-password-reset" },
  sessionIp: { method: "GET", path: "/v1/auth/session" },
} as const;

/** Lowercased, trimmed email form used for per-email limiter keys. */
export function normalizeEmailForLimit(email: string): string {
  return email.trim().toLowerCase();
}

/** True when the request matches method + path (path has no trailing slash). */
function routeMatches(req: Request, method: string, path: string): boolean {
  if (req.method !== method) return false;
  const pathname = (req.originalUrl ?? req.url ?? "/").split("?")[0] ?? "/";
  return pathname === path;
}

/** The email address carried by a JSON body, or "" when absent/foreign. */
function emailFromBody(req: Request): string {
  const body: unknown = req.body;
  if (body === null || typeof body !== "object") return "";
  const email = (body as { email?: unknown }).email;
  return typeof email === "string" ? email : "";
}

/**
 * Writes the stable 429 response: RFC 9457 Problem Details with
 * `code: "rate_limited"` (contracts package), the `errors.rateLimited.title`
 * i18n key resolved for the title (the `detail` carries the raw i18n key so
 * any client can localize), and the `Retry-After` header in whole seconds.
 */
export function sendRateLimited(res: Response, retryAfterSec: number): void {
  const { problem } = rateLimited(retryAfterSec);
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
  res.status(429).type("application/problem+json").json({
    ...problem,
    title: t(RATE_LIMITED_I18N_KEY as never),
  });
}

/**
 * Records one attempt against `key` under `rule`; returns false (after
 * sending the 429) when the limit is exhausted.
 */
function checkOr429(
  res: Response,
  limiter: RateLimiter,
  key: string,
  rule: RateLimitRule,
): boolean {
  const result = limiter.check(key, rule.limit, rule.windowMs);
  if (!result.ok) {
    sendRateLimited(res, result.retryAfterSec);
    return false;
  }
  return true;
}

/**
 * Builds the global rate-limit guard. `limiter` is the app-wide in-memory
 * limiter (also exposed to Nest DI); `trustedIpConfig` feeds the client-IP
 * derivation.
 */
export function createRateLimitGuard(
  limiter: RateLimiter,
  trustedIpConfig: TrustedIpConfig,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = deriveClientIp(req, trustedIpConfig) ?? "unknown";

    if (routeMatches(req, RATE_LIMITED_ROUTES.signUpIp.method, RATE_LIMITED_ROUTES.signUpIp.path)) {
      if (!checkOr429(res, limiter, keyFor(["signup", "ip", clientIp]), SIGNUP_PER_HOUR_PER_IP)) return;
    }

    if (routeMatches(req, RATE_LIMITED_ROUTES.signInIp.method, RATE_LIMITED_ROUTES.signInIp.path)) {
      // IP dimension first: a spoofed/absent email must not skip the IP gate,
      // and an exhausted IP bucket must not consume per-email slots.
      if (!checkOr429(res, limiter, keyFor(["signin", "ip", clientIp]), SIGNIN_PER_15MIN_PER_IP)) return;
      const email = normalizeEmailForLimit(emailFromBody(req));
      if (email !== "" && !checkOr429(res, limiter, keyFor(["signin", "email", email]), SIGNIN_PER_15MIN_PER_EMAIL)) {
        return;
      }
    }

    if (routeMatches(req, RATE_LIMITED_ROUTES.resetIp.method, RATE_LIMITED_ROUTES.resetIp.path)) {
      const email = normalizeEmailForLimit(emailFromBody(req));
      // Per-EMAIL first (the tighter 3/hour limit) — the IP attempt is still
      // consumed, mirroring the sign-in ordering rationale.
      if (email !== "" && !checkOr429(res, limiter, keyFor(["reset", "email", email]), RESET_PER_HOUR_PER_EMAIL)) {
        return;
      }
      if (!checkOr429(res, limiter, keyFor(["reset", "ip", clientIp]), RESET_PER_HOUR_PER_IP)) return;
    }

    if (routeMatches(req, RATE_LIMITED_ROUTES.sessionIp.method, RATE_LIMITED_ROUTES.sessionIp.path)) {
      if (!checkOr429(res, limiter, keyFor(["session", "ip", clientIp]), SESSION_PER_MINUTE_PER_IP)) return;
    }

    next();
  };
}

/** Re-export so wiring/tests import rules from one place. */
export { RATE_LIMIT_RULES };
