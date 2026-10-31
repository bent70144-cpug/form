import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_PROXY_HEADERS,
  deriveClientIp,
  isRenderEnv,
  loadTrustedIpConfig,
  normalizeIp,
  resolveDefaultTrustedProxyCount,
  TrustedIpConfigError,
  type ForwardedRequest,
} from "../src/common/trusted-ip";

/**
 * Builds a supertest-style fake request — no server needed. These shapes are
 * the hop shapes NestJS actually sees (ADR-0003 observations):
 *   - direct in-process call:            peer 127.0.0.1 (or ::1), no headers
 *   - through the Next.js /v1/* rewrite: peer 127.0.0.1 (the Next process),
 *     headers = whatever the upstream passed through
 *   - behind Render:                     peer 127.0.0.1 (Next, same host),
 *     x-forwarded-for attested by the Render edge
 */
function req(
  remoteAddress: string | null,
  headers: Record<string, string | string[]> = {},
): ForwardedRequest {
  return { socket: { remoteAddress }, headers };
}

/** Render-style alpha hop: Next process is the peer, edge attests the client. */
const RENDER_PEER = "127.0.0.1";
const REAL_CLIENT = "203.0.113.9";

describe("deriveClientIp — untrusted peer (trustedProxyCount: 0, local default)", () => {
  it("ignores a spoofed X-Forwarded-For and returns the socket peer", () => {
    const derived = deriveClientIp(
      req("198.51.100.7", { "x-forwarded-for": REAL_CLIENT }),
      { trustedProxyCount: 0 },
    );
    expect(derived).toBe("198.51.100.7");
  });

  it("is the default locally: no config, no RENDER env, peer through the rewrite wins", () => {
    // Peer is the Next process on loopback (ADR-0003 hop observation); the
    // attacker-set header must not move the derived address.
    const derived = deriveClientIp(req(RENDER_PEER, { "x-forwarded-for": "1.2.3.4" }));
    expect(derived).toBe(RENDER_PEER);
  });

  it("never consults any configured header when the peer is untrusted", () => {
    const derived = deriveClientIp(
      req("198.51.100.7", { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }),
      { trustedProxyCount: 0, trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    );
    expect(derived).toBe("198.51.100.7");
  });
});

describe("deriveClientIp — trusted chain (Render-style, trustedProxyCount: 1)", () => {
  const renderConfig = { trustedProxyCount: 1, trustedProxyHeaders: ["x-forwarded-for"] };

  it("derives the edge-attested client IP behind the rewrite", () => {
    expect(deriveClientIp(req(RENDER_PEER, { "x-forwarded-for": REAL_CLIENT }), renderConfig)).toBe(
      REAL_CLIENT,
    );
  });

  it("defeats spoofing: the edge appends the real client, rightmost wins", () => {
    // Client sent XFF: 1.2.3.4; the Render edge appended the true address.
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": `1.2.3.4, ${REAL_CLIENT}` }),
      renderConfig,
    );
    expect(derived).toBe(REAL_CLIENT);
  });

  it("skips non-IP garbage without consuming a trusted hop", () => {
    // Rotating garbage must not mint fresh rate-limit buckets.
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": `not-an-ip, ${REAL_CLIENT}` }),
      renderConfig,
    );
    expect(derived).toBe(REAL_CLIENT);
  });

  it("fails closed to the peer when the header carries only garbage", () => {
    const derived = deriveClientIp(req(RENDER_PEER, { "x-forwarded-for": "<script>" }), renderConfig);
    expect(derived).toBe(RENDER_PEER);
  });

  it("falls back to the peer when no forwarded header is present (internal call)", () => {
    // Server components call the internal API port directly — loopback.
    expect(deriveClientIp(req(RENDER_PEER), renderConfig)).toBe(RENDER_PEER);
  });

  it("handles duplicate header lines (array form) like Node delivers them", () => {
    // Node joins duplicate XFF lines with ", " — exercise the array shape too.
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": [`1.2.3.4, ${REAL_CLIENT}`] }),
      renderConfig,
    );
    expect(derived).toBe(REAL_CLIENT);
  });
});

describe("deriveClientIp — deeper chains (trustedProxyCount: 2)", () => {
  const twoProxyConfig = { trustedProxyCount: 2, trustedProxyHeaders: ["x-forwarded-for"] };
  // client(203.0.113.9) → proxyA(10.0.0.1) → proxyB(10.0.0.2, our peer)
  const twoProxyHeaders = { "x-forwarded-for": `${REAL_CLIENT}, 10.0.0.1` };

  it("walks right-to-left through both trusted hops to the client", () => {
    expect(deriveClientIp(req("10.0.0.2", twoProxyHeaders), twoProxyConfig)).toBe(REAL_CLIENT);
  });

  it("leaves spoofed entries left of the attested chain untouched", () => {
    const derived = deriveClientIp(
      req("10.0.0.2", { "x-forwarded-for": `evil.example, ${twoProxyHeaders["x-forwarded-for"]}` }),
      twoProxyConfig,
    );
    expect(derived).toBe(REAL_CLIENT);
  });

  it("derives the appended client address when the chain is shorter than the trusted count", () => {
    // One real proxy appended the client, count=2: the chain runs out before
    // the hops do, and the walk lands on the attested client address.
    const derived = deriveClientIp(req("10.0.0.2", { "x-forwarded-for": REAL_CLIENT }), twoProxyConfig);
    expect(derived).toBe(REAL_CLIENT);
  });

  it("over-counting shifts the derivation one valid entry left (documented limitation)", () => {
    // TRUSTED_PROXY_COUNT MUST match the real topology: with one real proxy
    // but count=2, a client-supplied valid IP left of the honest append is
    // consumed as if a second proxy had attested it (same trade-off as
    // Express's count-based `trust proxy`; see ADR-0004).
    const derived = deriveClientIp(
      req("10.0.0.2", { "x-forwarded-for": `198.51.100.66, ${REAL_CLIENT}` }),
      twoProxyConfig,
    );
    expect(derived).toBe("198.51.100.66");
  });

  it("non-IP entries never shift the derivation even when over-counted", () => {
    const derived = deriveClientIp(
      req("10.0.0.2", { "x-forwarded-for": `garbage.example, ${REAL_CLIENT}` }),
      twoProxyConfig,
    );
    expect(derived).toBe(REAL_CLIENT);
  });
});

describe("deriveClientIp — header configuration", () => {
  it("matches configured header names case-insensitively", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": REAL_CLIENT }),
      { trustedProxyCount: 1, trustedProxyHeaders: ["X-Forwarded-For"] },
    );
    expect(derived).toBe(REAL_CLIENT);
  });

  it("prefers the platform-attested header over X-Forwarded-For (Cloudflare-style)", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, {
        "cf-connecting-ip": "198.51.100.20",
        "x-forwarded-for": "1.2.3.4",
      }),
      { trustedProxyCount: 1, trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    );
    expect(derived).toBe("198.51.100.20");
  });

  it("falls back to the next header when the platform header is absent", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": REAL_CLIENT }),
      { trustedProxyCount: 1, trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    );
    expect(derived).toBe(REAL_CLIENT);
  });

  it("fails closed to the peer when a header only has invalid entries", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, { "cf-connecting-ip": "garbage", "x-forwarded-for": REAL_CLIENT }),
      { trustedProxyCount: 1, trustedProxyHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    );
    // The garbage-only platform header is skipped, then xff is honored.
    expect(derived).toBe(REAL_CLIENT);
  });
});

describe("deriveClientIp — IPv6", () => {
  it("returns the IPv6 loopback peer unchanged when no header is present", () => {
    expect(deriveClientIp(req("::1"), { trustedProxyCount: 0 })).toBe("::1");
  });

  it("collapses IPv4-mapped IPv6 peers to plain IPv4", () => {
    expect(deriveClientIp(req("::ffff:127.0.0.1"), { trustedProxyCount: 0 })).toBe("127.0.0.1");
  });

  it("collapses IPv4-mapped entries inside the trusted chain", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": "::ffff:203.0.113.9" }),
      { trustedProxyCount: 1 },
    );
    expect(derived).toBe("203.0.113.9");
  });

  it("uppercases in headers do not create separate identities", () => {
    const derived = deriveClientIp(
      req(RENDER_PEER, { "x-forwarded-for": "2001:DB8::1" }),
      { trustedProxyCount: 1 },
    );
    expect(derived).toBe("2001:db8::1");
  });
});

describe("deriveClientIp — degenerate inputs", () => {
  it("returns null when the request has no socket peer", () => {
    expect(deriveClientIp(req(null), { trustedProxyCount: 1 })).toBeNull();
    expect(deriveClientIp(req(""), { trustedProxyCount: 1 })).toBeNull();
    expect(deriveClientIp({}, { trustedProxyCount: 1 })).toBeNull();
  });

  it("treats an empty-string header as absent", () => {
    expect(deriveClientIp(req(RENDER_PEER, { "x-forwarded-for": "" }), { trustedProxyCount: 1 })).toBe(
      RENDER_PEER,
    );
  });
});

describe("normalizeIp", () => {
  it("strips the IPv4-mapped prefix case-insensitively", () => {
    expect(normalizeIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(normalizeIp("::FFFF:192.0.2.128")).toBe("192.0.2.128");
  });

  it("lowercases IPv6 and leaves IPv4 and garbage as-is", () => {
    expect(normalizeIp("2001:DB8::A")).toBe("2001:db8::a");
    expect(normalizeIp("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("  127.0.0.1  ")).toBe("127.0.0.1");
  });
});

describe("loadTrustedIpConfig", () => {
  it("defaults to 0 trusted proxies and x-forwarded-for outside Render", () => {
    expect(loadTrustedIpConfig({})).toEqual({
      trustedProxyCount: 0,
      trustedProxyHeaders: ["x-forwarded-for"],
    });
  });

  it("defaults to 1 trusted proxy on Render (RENDER=true)", () => {
    expect(loadTrustedIpConfig({ RENDER: "true" }).trustedProxyCount).toBe(1);
    expect(isRenderEnv({ RENDER_SERVICE_ID: "srv-123" })).toBe(true);
    expect(resolveDefaultTrustedProxyCount({ RENDER: "false" })).toBe(0);
  });

  it("honors explicit TRUSTED_PROXY_COUNT over environment detection", () => {
    expect(loadTrustedIpConfig({ RENDER: "true", TRUSTED_PROXY_COUNT: "2" }).trustedProxyCount).toBe(2);
    expect(loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "0" }).trustedProxyCount).toBe(0);
    expect(loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "" }).trustedProxyCount).toBe(0);
  });

  it("parses TRUSTED_PROXY_HEADERS as a lowercased priority list", () => {
    expect(
      loadTrustedIpConfig({ TRUSTED_PROXY_HEADERS: "CF-Connecting-IP, X-Forwarded-For" })
        .trustedProxyHeaders,
    ).toEqual(["cf-connecting-ip", "x-forwarded-for"]);
  });

  it("throws TrustedIpConfigError on invalid values (fails at startup)", () => {
    expect(() => loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "abc" })).toThrow(TrustedIpConfigError);
    expect(() => loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "-1" })).toThrow(TrustedIpConfigError);
    expect(() => loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "1.5" })).toThrow(TrustedIpConfigError);
    try {
      loadTrustedIpConfig({ TRUSTED_PROXY_COUNT: "99" });
      expect.unreachable();
    } catch (err) {
      expect((err as TrustedIpConfigError).issues[0]?.path).toContain("TRUSTED_PROXY_COUNT");
    }
  });

  it("exposes the default header contract", () => {
    expect(DEFAULT_TRUSTED_PROXY_HEADERS).toEqual(["x-forwarded-for"]);
  });
});
