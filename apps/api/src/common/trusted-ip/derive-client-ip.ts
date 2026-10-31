import { isIP } from "node:net";
import {
  DEFAULT_TRUSTED_PROXY_HEADERS,
  resolveDefaultTrustedProxyCount,
  type TrustedIpConfig,
} from "./config";

/**
 * Trusted-proxy client-IP derivation (spec: "It trusts only the platform's
 * forwarded client-IP header ... and spoofed forwarded headers cannot change
 * the derived address").
 *
 * Algorithm — walk the socket peer address plus the trusted header chain from
 * RIGHT to LEFT, only accepting forwarded values added by trusted proxies:
 *
 *   1. `peer = req.socket.remoteAddress` is trusted hop #1 when
 *      `trustedProxyCount >= 1`; with `trustedProxyCount === 0` the peer is
 *      NOT trusted and every forwarded header is ignored — the derived IP is
 *      the peer itself (a spoofed X-Forwarded-For cannot change the result).
 *   2. Each further step to the LEFT through the configured header chain
 *      consumes one more trusted hop. The walk stops after
 *      `trustedProxyCount` hops, so only the rightmost N entries — the ones
 *      honest proxies appended — can influence the result; anything further
 *      left is client-supplied and discarded.
 *   3. Chain entries that are not valid IP literals are skipped without
 *      consuming a trusted hop (honest proxies only append real addresses;
 *      garbage must not mint fresh rate-limit buckets).
 *   4. If the chain runs out before the hops do, the walk result is the
 *      leftmost attested address (or the peer when no header is present —
 *      e.g. server-side calls that reach the internal port directly).
 *
 * Hop shapes (see ADR-0003 observations and ADR-0004):
 *   - Direct in-process / local through the Next.js `/v1/*` rewrite: the peer
 *     is `127.0.0.1` (the Next process). With the local default of 0 trusted
 *     proxies the derived IP is `127.0.0.1` — spoof-proof by construction.
 *   - Behind Render (single-service alpha): browser → Render edge → Next →
 *     rewrite → NestJS. The Render edge attests the real client IP in
 *     `X-Forwarded-For`; Next must pass that header through unchanged (the
 *     header contract for ticket 04 wiring). `TRUSTED_PROXY_COUNT` defaults
 *     to 1 via Render environment detection, so the rightmost `X-Forwarded-For`
 *     entry — the edge-appended value — is the derived client IP.
 *   - Cloudflare (beta): prepend `cf-connecting-ip` to
 *     `TRUSTED_PROXY_HEADERS` and raise `TRUSTED_PROXY_COUNT` to 2.
 *
 * Over-counting `trustedProxyCount` shifts the derivation one entry further
 * LEFT per excess hop, so the value must match the real deployment topology.
 */

/**
 * Structural request shape used by `deriveClientIp`. Express `Request` and
 * supertest-style fake objects (`{ socket: { remoteAddress }, headers }`)
 * both satisfy it, so tests need no server.
 */
export interface ForwardedRequest {
  socket?: { remoteAddress?: string | null } | null;
  headers?: Record<string, string | string[] | undefined>;
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Canonicalizes an IP literal for use as a rate-limit key: IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) collapses to the plain IPv4 form; IPv6 lowercases.
 * `::1` stays `::1` (distinct from `127.0.0.1` but consistently keyed).
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = IPV4_MAPPED.exec(trimmed);
  const v4 = mapped?.[1];
  if (v4 !== undefined) return v4;
  return trimmed.toLowerCase();
}

/** True when the string is a valid IPv4 or IPv6 literal after normalization. */
function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0;
}

/**
 * Extracts the forwarded chain from the first configured header that carries
 * at least one valid IP entry. Header-name lookup is case-insensitive (Node
 * lowercases `req.headers` keys; configured names are lowercased here so
 * callers may pass "X-Forwarded-For"). Returns entries left-to-right; the
 * caller walks from the end. Empty array when nothing usable is present.
 */
function extractChain(
  headers: Record<string, string | string[] | undefined>,
  headerNames: readonly string[],
): string[] {
  for (const name of headerNames) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const lines = Array.isArray(raw) ? raw : [raw];
    const entries = lines
      .flatMap((line) => line.split(","))
      .map((entry) => normalizeIp(entry))
      .filter((entry) => entry.length > 0 && isValidIp(entry));
    if (entries.length > 0) return entries;
  }
  return [];
}

/**
 * Resolves the real client IP for a request, or `null` when the request has
 * no socket peer address at all. See the module docs for the algorithm and
 * the per-deployment hop shapes.
 */
export function deriveClientIp(
  req: ForwardedRequest,
  config: Partial<TrustedIpConfig> = {},
): string | null {
  const trustedProxyCount =
    config.trustedProxyCount ?? resolveDefaultTrustedProxyCount(process.env);
  const headerNames = (
    config.trustedProxyHeaders ?? DEFAULT_TRUSTED_PROXY_HEADERS
  ).map((name) => name.toLowerCase());

  const rawPeer = req.socket?.remoteAddress ?? null;
  if (rawPeer === null || rawPeer.length === 0) return null;
  const peer = normalizeIp(rawPeer);

  // Untrusted direct peer: forwarded headers are never consulted, so a
  // spoofed X-Forwarded-For cannot change the derived address.
  if (trustedProxyCount <= 0) return peer;

  const chain = extractChain(req.headers ?? {}, headerNames);
  let derived = peer;
  let index = chain.length - 1;
  let hopsLeft = trustedProxyCount;
  while (hopsLeft > 0 && index >= 0) {
    derived = chain[index] as string;
    index -= 1;
    hopsLeft -= 1;
  }
  return derived;
}
