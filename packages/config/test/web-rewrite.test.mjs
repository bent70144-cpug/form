import { describe, expect, it } from "vitest";
import { buildRewrites } from "../../apps/web/next.config.mjs";

/**
 * Config-level proof of the Next.js `/v1/*` rewrite (ticket 02): the public
 * Next process proxies API calls to the INTERNAL NestJS URL, and the only
 * variable it needs for that is API_INTERNAL_URL. The full browser → Next →
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
});
