import { describe, expect, it } from "vitest";
import { buildRewrites } from "../../apps/web/next.config.ts";

/**
 * Config-level proof of the Next.js `/v1/*` rewrite (ticket 02): the public
 * Next process proxies API calls to the INTERNAL NestJS URL, and the only
 * variables it needs for that are API_INTERNAL_URL / API_INTERNAL_PORT
 * (supervisor allowlists both for the web child). The full browser → Next →
 * Nest round-trip is exercised with the documented curl runbook
 * (docs/adr/0003-topology-spike.md) and the API-side integration test.
 */
describe("apps/web next.config rewrites", () => {
  it("rewrites /v1/:path* to the internal API preserving the /v1 prefix", () => {
    expect(buildRewrites("http://127.0.0.1:4000")).toEqual([
      { source: "/v1/:path*", destination: "http://127.0.0.1:4000/v1/:path*" },
    ]);
  });

  it("defaults to the documented internal port when no env var is set", () => {
    expect(buildRewrites(undefined)[0].destination).toBe(
      "http://127.0.0.1:4000/v1/:path*",
    );
  });

  it("honors API_INTERNAL_URL and tolerates a trailing slash", () => {
    expect(buildRewrites("http://api.internal:4123/")[0].destination).toBe(
      "http://api.internal:4123/v1/:path*",
    );
  });

  it("falls back to http://127.0.0.1:${API_INTERNAL_PORT:-4000} when only the port is set", () => {
    expect(buildRewrites(undefined, "4001")[0].destination).toBe(
      "http://127.0.0.1:4001/v1/:path*",
    );
    // ${API_INTERNAL_PORT:-4000} shell semantics: unset port → 4000.
    expect(buildRewrites(undefined, undefined)[0].destination).toBe(
      "http://127.0.0.1:4000/v1/:path*",
    );
  });

  it("prefers the explicit internal URL over the port", () => {
    expect(buildRewrites("http://api.internal:4123", "9999")[0].destination).toBe(
      "http://api.internal:4123/v1/:path*",
    );
  });
});
