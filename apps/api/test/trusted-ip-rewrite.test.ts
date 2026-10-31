import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { loadApiEnv } from "../src/env";
import { createApiApp } from "../src/app";

/**
 * Ticket 04 — trusted client-IP derivation across the REAL hop: a spawned
 * `next dev` (the actual public deployable, /v1/* rewrite → internal API) in
 * front of the real NestJS app, asserting what Nest DERIVES (the
 * `x-derived-client-ip` hop-diagnostics header, non-production only) and
 * that spoofed `X-Forwarded-For` variants cannot change it (spec: "It trusts
 * only the platform's forwarded client-IP header … and spoofed forwarded
 * headers cannot change the derived address. Tests exercise the actual
 * browser → Next.js `/v1/*` rewrite → NestJS hop").
 *
 * Two phases on the SAME Next process (the rewrite targets a fixed internal
 * port; the API behind it is swapped between phases):
 *
 * - Phase A — TRUSTED_PROXY_COUNT=0 (the LOCAL topology, ADR-0003): the peer
 *   is the Next process on loopback and EVERY forwarded header is ignored →
 *   spoof immunity by construction. Also proves the session-endpoint limit
 *   keys on the derived loopback IP through the real rewrite hop.
 * - Phase B — TRUSTED_PROXY_COUNT=1 (the RENDER topology): the rightmost
 *   X-Forwarded-For entry is the edge-attested client; entries further LEFT
 *   are client-supplied and discarded, and garbage entries are skipped
 *   without minting fresh buckets. The header pass-through contract (Next
 *   forwards XFF unchanged) is asserted from what Nest receives.
 *
 * No database is touched: only /v1/health and cookie-less /v1/auth/session
 * (401) are exercised; the rate limit fires before any handler runs.
 */

const WEB_ROOT = path.resolve(__dirname, "../../web");
const API_ORIGIN = "http://localhost:3000";

let apiPort: number;
let webPort: number;
let nextDev: ChildProcess | null = null;
/** The phase-A API server (listening BEFORE waitForWeb so the rewrite works). */
let phaseAServer: net.Server | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function listenApi(trustedProxyCount: number) {
  const env = loadApiEnv({
    PORT: "4000",
    DATABASE_URL: "postgres://app_user:x@127.0.0.1:5433/form_none",
    APP_ORIGIN: API_ORIGIN,
    BETTER_AUTH_SECRET: "trusted-ip-rewrite-test-secret",
    NODE_ENV: "test",
    TRUSTED_PROXY_COUNT: String(trustedProxyCount),
  });
  const app = await createApiApp(env, { rateLimits: { enabled: true } });
  const server = app.expressApp.listen(apiPort, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, app };
}

async function waitForWeb(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${webPort}/v1/health`);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next dev did not serve /v1/health in time: ${lastError}`);
}

interface Hop {
  status: number;
  derived: string | null;
  peer: string | null;
  forwardedFor: string | null;
  retryAfter: string | null;
}

async function hop(
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<Hop> {
  const res = await fetch(`http://127.0.0.1:${webPort}${urlPath}`, { headers });
  return {
    status: res.status,
    derived: res.headers.get("x-derived-client-ip"),
    peer: res.headers.get("x-hop-peer-address"),
    forwardedFor: res.headers.get("x-hop-forwarded-for"),
    retryAfter: res.headers.get("retry-after"),
  };
}

beforeAll(async () => {
  apiPort = await freePort();
  webPort = await freePort();
  nextDev = spawn(
    path.join(WEB_ROOT, "node_modules", ".bin", "next"),
    ["dev", "--port", String(webPort), "--hostname", "127.0.0.1"],
    {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  nextDev.stderr?.on("data", () => undefined); // drain
  // The phase-A API must be listening BEFORE waitForWeb: the Next.js rewrite
  // targets it, and a dead upstream answers 500 forever (hook-order bug of
  // the first draft — fixed by starting the API here).
  ({ server: phaseAServer } = await listenApi(0));
  await waitForWeb();
});

afterAll(async () => {
  if (nextDev) {
    nextDev.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        nextDev?.kill("SIGKILL");
        resolve();
      }, 5000);
      nextDev?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    nextDev = null;
  }
});

describe("phase A — local topology (0 trusted proxies): spoof immunity by construction", () => {
  afterAll(async () => {
    // Free the shared internal port for phase B's fresh app + limiter.
    await new Promise<void>((resolve) => phaseAServer?.close(() => resolve()));
    phaseAServer = null;
  });

  it("derives the Next process's loopback peer through the real rewrite", async () => {
    const h = await hop("/v1/health");
    expect(h.status).toBe(200);
    expect(h.peer).toBe("127.0.0.1");
    expect(h.derived).toBe("127.0.0.1");
  });

  it("spoofed X-Forwarded-For variants CANNOT change the derived IP", async () => {
    for (const spoof of [
      "203.0.113.7",
      "203.0.113.7, 10.9.9.9",
      "not-an-ip, 203.0.113.7",
      "10.0.0.1, 10.0.0.2, 203.0.113.7",
    ]) {
      const h = await hop("/v1/health", { "x-forwarded-for": spoof });
      expect(h.status).toBe(200);
      expect(h.forwardedFor).toBe(spoof); // Next passes the header through…
      expect(h.derived).toBe("127.0.0.1"); // …but an untrusted peer is never moved
    }
  });

  it("a spoofed Forwarded header is ignored too", async () => {
    const h = await hop("/v1/health", { forwarded: "for=203.0.113.7" });
    expect(h.derived).toBe("127.0.0.1");
  });

  it("the session limit keys on the DERIVED loopback IP through the real hop", async () => {
    // 120 cookie-less 401s inside the per-minute budget…
    for (let i = 0; i < 120; i += 1) {
      const h = await hop("/v1/auth/session");
      expect(h.status).toBe(401);
    }
    // …the 121st is rate limited with the stable problem contract.
    const over = await hop("/v1/auth/session");
    expect(over.status).toBe(429);
    expect(over.retryAfter).toMatch(/^\d+$/);
  });
});

describe("phase B — Render topology (1 trusted proxy): only the rightmost entry attests", () => {
  let server: net.Server;

  beforeAll(async () => {
    // Same internal port, fresh app + limiter with TRUSTED_PROXY_COUNT=1 —
    // exactly what Render's platform edge is in front of the Next process.
    ({ server } = await listenApi(1));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("derives the edge-attested client from the rightmost XFF entry", async () => {
    const h = await hop("/v1/health", { "x-forwarded-for": "203.0.113.7" });
    expect(h.derived).toBe("203.0.113.7");
  });

  it("spoofed entries LEFT of the attested client are discarded", async () => {
    // What Render actually receives when a client spoofs XFF: the edge
    // APPENDS the real client address, so honest values sit rightmost.
    const h = await hop("/v1/health", {
      "x-forwarded-for": "198.51.100.1, 203.0.113.7",
    });
    expect(h.forwardedFor).toBe("198.51.100.1, 203.0.113.7"); // pass-through
    expect(h.derived).toBe("203.0.113.7"); // spoof on the left has no effect
  });

  it("garbage chain entries are skipped without minting new buckets", async () => {
    const h = await hop("/v1/health", {
      "x-forwarded-for": "not-an-ip, 203.0.113.7",
    });
    expect(h.derived).toBe("203.0.113.7");
  });

  it("the rightmost entry wins when the client spoofs (Render append shape)", async () => {
    const h = await hop("/v1/health", {
      "x-forwarded-for": "203.0.113.7, 198.51.100.2",
    });
    expect(h.derived).toBe("198.51.100.2");
  });

  it("session limits key on the derived client IP, not the peer", async () => {
    // 121 requests attesting 203.0.113.7 → the 121st hits ITS bucket limit…
    for (let i = 0; i < 120; i += 1) {
      const h = await hop("/v1/auth/session", {
        "x-forwarded-for": "203.0.113.7",
      });
      expect(h.status).toBe(401);
    }
    const over = await hop("/v1/auth/session", {
      "x-forwarded-for": "203.0.113.7",
    });
    expect(over.status).toBe(429);
    // …while a DIFFERENT derived client keeps its own fresh bucket — proof
    // the guard keyed on the trusted chain (the TCP peer stayed 127.0.0.1).
    const other = await hop("/v1/auth/session", {
      "x-forwarded-for": "203.0.113.8",
    });
    expect(other.status).toBe(401);
  });
});
