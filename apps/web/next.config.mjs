/**
 * apps/web — Next.js public deployable (ticket 02 alpha topology spike).
 *
 * The web process is deliberately dumb: it renders the dashboard/public pages
 * and same-origin-proxies `/v1/*` to the NestJS API. It receives NO database
 * URL and NO auth secret (supervisor allowlist — packages/config supervisor
 * test). The only server-side variable it needs is API_INTERNAL_URL, the
 * internal (non-public) base URL of the NestJS process.
 *
 * Hop chain (recorded in docs/adr/0003-topology-spike.md):
 *   browser → Next.js rewrite `/v1/:path*` → NestJS `http://127.0.0.1:$API_PORT/v1/:path*`
 *
 * On Render the same rewrite targets the internal port; the peer address Nest
 * sees locally is 127.0.0.1 (the Next process), and behind Render it is the
 * platform proxy — trusted-proxy derivation is ticket 04's job.
 */

/**
 * Build the rewrite list from the internal API base URL. Exported so the
 * config-level test (packages/config/test/web-rewrite.test.mjs) can assert
 * the exact hop without booting Next.
 */
export function buildRewrites(apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000") {
  const base = apiInternalUrl.replace(/\/$/, "");
  return [{ source: "/v1/:path*", destination: `${base}/v1/:path*` }];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return buildRewrites();
  },
};

export default nextConfig;
