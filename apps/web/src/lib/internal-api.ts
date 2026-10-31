/**
 * Internal API coordinates for the Next.js process (supervisor-allowlisted:
 * API_INTERNAL_URL full base URL or API_INTERNAL_PORT on 127.0.0.1, default
 * 4000 — see scripts/supervisor.mjs and ADR 0003).
 *
 * Server components call the API DIRECTLY on this internal URL (never through
 * the public domain or the /v1 rewrite); browser calls use the same-origin
 * rewrite and never need this module.
 */
export function internalApiUrl(): string {
  return (
    process.env.API_INTERNAL_URL ??
    `http://127.0.0.1:${process.env.API_INTERNAL_PORT ?? 4000}`
  );
}
