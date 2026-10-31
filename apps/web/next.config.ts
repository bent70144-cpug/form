import type { NextConfig } from "next";

/**
 * apps/web — Next.js public deployable (ticket 02 alpha topology spike).
 *
 * The web process is deliberately dumb: it renders the dashboard/public pages
 * and same-origin-proxies `/v1/*` to the NestJS API. It receives NO database
 * URL and NO auth secret (supervisor allowlist — packages/config supervisor
 * test). The only server-side variables it needs are API_INTERNAL_URL (full
 * internal base URL) or API_INTERNAL_PORT (port on 127.0.0.1).
 *
 * Hop chain (recorded in docs/adr/0003-topology-spike.md):
 *   browser → Next.js rewrite `/v1/:path*` → NestJS `http://127.0.0.1:$API_PORT/v1/:path*`
 *
 * On Render the same rewrite targets the internal port; the peer address Nest
 * sees locally is 127.0.0.1 (the Next process), and behind Render it is the
 * platform proxy — trusted-proxy derivation is ticket 04's job.
 */

/**
 * Build the rewrite list from the internal API coordinates. Precedence:
 * API_INTERNAL_URL → API_INTERNAL_PORT → the documented default 4000
 * (i.e. `http://127.0.0.1:${API_INTERNAL_PORT:-4000}`). Exported so the
 * config-level test (packages/config/test/web-rewrite.test.mjs) can assert
 * the exact hop without booting Next.
 */
export function buildRewrites(
  apiInternalUrl: string | undefined = process.env.API_INTERNAL_URL,
  apiInternalPort: string | undefined = process.env.API_INTERNAL_PORT,
): Array<{ source: string; destination: string }> {
  const base = (apiInternalUrl ?? `http://127.0.0.1:${apiInternalPort ?? 4000}`).replace(
    /\/$/,
    "",
  );
  return [{ source: "/v1/:path*", destination: `${base}/v1/:path*` }];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return buildRewrites();
  },
};

export default nextConfig;
