/**
 * Public app-origin resolution for absolute URLs (ticket 09 copy-link).
 *
 * The publish controls build the respondent-facing URL
 * `{APP_ORIGIN}/f/{slug}`. The SERVER component derives the origin from the
 * incoming request (proxy hop chain: `x-forwarded-host` first, then `host`,
 * with `x-forwarded-proto` — defaulting per host shape when the proxy did not
 * set it) and falls back to the informational NEXT_PUBLIC_APP_ORIGIN. The
 * logic is pure so it is unit-testable without a request scope; the page
 * passes `await headers()` values in.
 *
 * The browser itself never needs this: mutations go through the same-origin
 * /v1/* rewrite, and the SSR page renders on the same origin.
 */

export interface OriginInput {
  forwardedHost?: string | null;
  host?: string | null;
  forwardedProto?: string | null;
  envOrigin?: string | null;
}

function isLoopbackHost(host: string): boolean {
  return (
    /^localhost(:|$)/.test(host) ||
    /^127\.0\.0\.1(:|$)/.test(host) ||
    /^\[::1\](:|$)/.test(host) ||
    host === "::1"
  );
}

/** First entry of a comma-separated proxy header value ("https, http"). */
function firstHop(value: string): string {
  return value.split(",")[0]!.trim();
}

/**
 * Resolves the public origin, or null when nothing usable is known. A
 * trailing slash on any input is normalized away.
 */
export function resolveAppOrigin(input: OriginInput): string | null {
  const host = (input.forwardedHost ?? input.host ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (host !== "") {
    const rawProto =
      input.forwardedProto && input.forwardedProto.trim() !== ""
        ? firstHop(input.forwardedProto)
        : isLoopbackHost(host)
          ? "http"
          : "https";
    return `${rawProto}://${host}`;
  }
  const env = (input.envOrigin ?? "").trim().replace(/\/+$/, "");
  return env !== "" ? env : null;
}
