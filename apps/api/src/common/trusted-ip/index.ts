/**
 * Trusted-client-IP derivation (ticket 04 library portion; reused by ticket
 * 10). Exports:
 *
 * - `deriveClientIp(req, config?)` — the trusted-proxy chain walk
 *   (`./derive-client-ip` has the full algorithm contract).
 * - `normalizeIp` — canonical key form for IP literals.
 * - `loadTrustedIpConfig(env?)` / `TrustedIpConfig` / `TrustedIpConfigError`
 *   — Zod-validated env slice (`TRUSTED_PROXY_COUNT`, `TRUSTED_PROXY_HEADERS`)
 *   with deployment defaults (1 hop on Render, 0 locally).
 * - `isRenderEnv`, `resolveDefaultTrustedProxyCount`, `DEFAULT_TRUSTED_PROXY_HEADERS`.
 *
 * HEADER CONTRACT for ticket 04 wiring (browser → Next.js `/v1/*` rewrite →
 * NestJS):
 *
 * - Next.js must pass platform forwarding headers through the rewrite
 *   unchanged (headers are forwarded by default; the wiring must not strip
 *   `x-forwarded-for`). Behind Render the edge attests the real client IP;
 *   the Next process is then merely a pass-through hop and the trusted chain
 *   walk reads the edge's value. `TRUSTED_PROXY_COUNT` defaults to 1 on Render.
 * - Locally there is no platform proxy: the socket peer is `127.0.0.1` (the
 *   Next process, see ADR-0003 hop observations), 0 proxies are trusted, and
 *   the derivation ignores every forwarded header — the spoof-proof default.
 * - Server components call the internal API port directly (not through the
 *   rewrite); those requests derive the loopback address, which is expected.
 */
export {
  DEFAULT_TRUSTED_PROXY_HEADERS,
  isRenderEnv,
  loadTrustedIpConfig,
  resolveDefaultTrustedProxyCount,
  trustedIpConfigFromValues,
  TrustedIpConfigError,
  type TrustedIpConfig,
} from "./config";
export {
  deriveClientIp,
  normalizeIp,
  type ForwardedRequest,
} from "./derive-client-ip";
