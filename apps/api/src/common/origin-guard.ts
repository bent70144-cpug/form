import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendProblem } from "./problem";

/**
 * Global Origin guard (spec: "Cookie-authenticated mutations pass a global
 * Origin check that runs before both Nest controllers and the mounted Better
 * Auth handler"). Runs as the FIRST route-touching middleware in createApiApp
 * — before the Better Auth mount and the Nest router.
 *
 * Rules:
 * - Safe methods (GET/HEAD/OPTIONS) never need an Origin: SSR server
 *   components fetch `GET /v1/auth/session` directly against the internal
 *   API URL with no Origin header at all.
 * - Every state-changing request (POST/PUT/PATCH/DELETE) must carry an
 *   `Origin` header exactly matching APP_ORIGIN. Missing or mismatched →
 *   403 `origin_mismatch` (RFC 9457 body). There is NO internal-call
 *   exemption — a bootstrap-shaped call from 127.0.0.1 without an Origin is
 *   rejected exactly like a cross-site call.
 * - The only exemptions are the explicit cookie-less public-route allowlist
 *   below (token-based email-verification link, future public session
 *   creation and submit). Exempted routes must never read the auth cookie;
 *   the suite asserts that behavior.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-less public routes exempt from the Origin check. Keep this list
 * explicit and minimal — everything state-changing not listed here requires
 * a matching Origin.
 */
export const ORIGIN_EXEMPT_PATHS: readonly string[] = [
  // Better Auth's token-based email-verification link (opened from an email
  // client — navigations carry no Origin header, and the route is cookie-less).
  "/v1/auth/verify-email",
  // Future public endpoints (ticket 05+, not built yet) — declared here so
  // the allowlist is reviewed in one place. They must stay cookie-less.
  "/v1/public/submissions",
  "/v1/public/sessions",
  // Ticket 09: the public render path is variable-segment shaped, so it is
  // matched by PUBLIC_FORM_READ_RE below rather than listed verbatim.
];

/** Public form session creation: POST /v1/public/forms/{slug}/sessions (T05+). */
export const PUBLIC_FORM_SESSION_RE = /^\/v1\/public\/forms\/[^/]+\/sessions$/;

/**
 * Public form render path (ticket 09): /v1/public/forms/{slug} — cookie-less
 * and UNauthenticated. GET is already exempt as a safe method; the entry makes
 * the whole path's cookie-less contract explicit (a future password gate may
 * POST here) and keeps the public allowlist reviewable in one place.
 */
export const PUBLIC_FORM_READ_RE = /^\/v1\/public\/forms\/[^/]+$/;

export function isExemptFromOriginCheck(pathname: string): boolean {
  return (
    ORIGIN_EXEMPT_PATHS.includes(pathname) ||
    PUBLIC_FORM_SESSION_RE.test(pathname) ||
    PUBLIC_FORM_READ_RE.test(pathname)
  );
}

export function isOriginRequired(method: string, pathname: string): boolean {
  return !SAFE_METHODS.has(method) && !isExemptFromOriginCheck(pathname);
}

/**
 * Compares an Origin header value against the configured app origin.
 * Both sides are parsed as URLs and compared by `origin` (scheme://host:port)
 * so trailing slashes/paths never matter.
 */
export function originMatches(
  originHeader: string | undefined,
  appOrigin: string,
): boolean {
  if (!originHeader) return false;
  try {
    return new URL(originHeader).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

export function originGuard(appOrigin: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const pathname = (req.originalUrl ?? req.url ?? "/").split("?")[0] ?? "/";
    if (!isOriginRequired(req.method, pathname)) {
      next();
      return;
    }
    if (!originMatches(req.headers.origin, appOrigin)) {
      sendProblem(res, 403, "origin_mismatch");
      return;
    }
    next();
  };
}
