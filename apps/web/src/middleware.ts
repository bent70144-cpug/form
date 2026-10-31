import { NextResponse, type NextRequest } from "next/server";

/**
 * Dashboard middleware — CHEAP cookie-presence check ONLY (spec: "Next.js
 * middleware performs only a cookie-presence check to redirect obviously
 * logged-out dashboard visits. It is not a security boundary").
 *
 * Every API mutation re-checks the session itself; an SSR render having seen
 * a valid session earlier authorizes nothing. Revoked sessions still carry
 * the cookie here, so they pass middleware and are redirected by the
 * dashboard server component on its next /v1/auth/session call.
 *
 * Production deployments get Better Auth's `__Secure-` cookie prefix
 * (useSecureCookies), so BOTH names are recognized. Matching a stale or
 * revoked cookie value is fine — this check intentionally validates NOTHING
 * about the session; the dashboard's cached SSR call does that.
 */
export const SESSION_COOKIE_NAME = "better-auth.session_token";
export const SECURE_SESSION_COOKIE_NAME = `__Secure-${SESSION_COOKIE_NAME}`;

/** True when the request carries NO session cookie (obviously signed out). */
export function isMissingSessionCookie(req: {
  cookies: { get(name: string): { value: string } | undefined };
}): boolean {
  return !(
    req.cookies.get(SESSION_COOKIE_NAME)?.value ??
    req.cookies.get(SECURE_SESSION_COOKIE_NAME)?.value
  );
}

export function middleware(req: NextRequest): NextResponse {
  if (isMissingSessionCookie(req)) {
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
