import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  createAuthCoreFixture,
  type AuthCoreFixture,
} from "./app-fixture";
import { SIGNUP_PER_HOUR_PER_IP } from "../src/common/rate-limit";

/**
 * Ticket 04 — the SPEC's auth rate limits applied to the REAL routes, driven
 * end-to-end over HTTP (rateLimits enabled on the fixture). One app = one
 * in-memory limiter with fixed windows far longer than a test run, so each
 * test starts from a clean slate via `rateLimiter.reset()`.
 *
 * The client IP through supertest is the loopback peer with 0 trusted
 * proxies → every request derives `127.0.0.1` (the spoof-proof local default,
 * ADR-0004). Cross-IP derivation is covered by trusted-ip-rewrite.test.ts
 * through the REAL Next.js rewrite hop.
 *
 * Per-email vs per-IP isolation: both sign-in dimensions have the same
 * 10-per-15-min budget, so filling one by HTTP fills the other too. The
 * isolation tests therefore seed ONE dimension's bucket directly on the
 * app-wide limiter (the exact key shape the guard uses) and prove the other
 * dimension still gates the real route.
 */

const SCRATCH_DB = "t04_auth_rate_limit";
let fx: AuthCoreFixture;
let app: Express;

const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB, {}, { rateLimits: { enabled: true } });
  app = fx.expressApp;
});

afterAll(async () => {
  await fx.close();
});

beforeEach(() => {
  fx.rateLimiter.reset();
});

function signUp(body: Record<string, unknown>, origin: string | null = ORIGIN) {
  const req = request(app).post("/v1/auth/sign-up/email");
  if (origin) req.set("Origin", origin);
  return req.send(body);
}

function signIn(email: string, password: string, origin: string | null = ORIGIN) {
  const req = request(app).post("/v1/auth/sign-in/email");
  if (origin) req.set("Origin", origin);
  return req.send({ email, password });
}

function requestReset(email: string) {
  return request(app)
    .post("/v1/auth/request-password-reset")
    .set("Origin", ORIGIN)
    .send({ email, redirectTo: `${ORIGIN}/reset-password` });
}

function getSession() {
  return request(app).get("/v1/auth/session");
}

/** Asserts the stable RFC 9457 429 contract (body + Retry-After). */
async function expectRateLimited(
  res: Awaited<ReturnType<ReturnType<typeof request>["send"]>>,
): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers["content-type"]).toContain("application/problem+json");
  expect(res.headers["retry-after"]).toMatch(/^\d+$/);
  expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  expect(res.body).toMatchObject({
    type: "https://form.example/errors/rate_limited",
    status: 429,
    code: "rate_limited",
    detail: "errors.rateLimited.title",
  });
  expect(res.body.title).toBe("Too many requests"); // resolved i18n title
}

describe("signup — 5 attempts per hour per IP", () => {
  it("admits the first 5 and 429s the 6th with the stable problem body", async () => {
    for (let i = 0; i < SIGNUP_PER_HOUR_PER_IP.limit; i += 1) {
      const res = await signUp({
        name: `User ${i}`,
        email: `signup-${i}@example.com`,
        password: "password-12-chars-min",
      });
      expect(res.status).toBe(200); // enumeration-safe shape either way
    }
    await expectRateLimited(
      (await signUp({
        name: "One too many",
        email: "signup-over@example.com",
        password: "password-12-chars-min",
      })) as never,
    );
  });
});

describe("sign-in — 10 per 15 min per IP and per email", () => {
  it("admits 10 distinct-email attempts from one IP, 429s the 11th", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await signIn(`signin-${i}@example.com`, "wrong-password-1");
      expect(res.status).toBe(401); // wrong credentials (email buckets fresh)
    }
    await expectRateLimited(
      (await signIn("signin-over@example.com", "wrong-password-1")) as never,
    );
  });

  it("the per-EMAIL dimension gates the real route even with a fresh IP bucket", async () => {
    // Seed ONLY the victim's email bucket to its limit (same key shape the
    // guard builds). The IP bucket stays fresh — the next 429 must come from
    // the EMAIL dimension.
    const victim = "victim@example.com";
    for (let i = 0; i < 10; i += 1) {
      const result = fx.rateLimiter.check(`signin:email:${victim}`, 10, 900_000);
      expect(result.ok).toBe(true);
    }
    await expectRateLimited((await signIn(victim, "wrong-password-1")) as never);
    // A different email from the SAME IP is unaffected (fresh bucket).
    expect((await signIn("other@example.com", "wrong-password-1")).status).toBe(401);
  });

  it("email keys are normalized — case variants share one bucket", async () => {
    const victim = "victim@example.com";
    for (let i = 0; i < 10; i += 1) {
      fx.rateLimiter.check(`signin:email:${victim}`, 10, 900_000);
    }
    // The guard lowercases + trims before keying.
    await expectRateLimited((await signIn("Victim@Example.com ", "wrong-password-1")) as never);
  });

  it("429s carry a monotonic Retry-After inside the window", async () => {
    for (let i = 0; i < 10; i += 1) {
      await signIn(`ra-${i}@example.com`, "wrong-password-1");
    }
    const first = await signIn("ra-over@example.com", "wrong-password-1");
    const second = await signIn("ra-over2@example.com", "wrong-password-1");
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    const ra1 = Number(first.headers["retry-after"]);
    const ra2 = Number(second.headers["retry-after"]);
    expect(ra1).toBeGreaterThanOrEqual(1);
    expect(ra2).toBeLessThanOrEqual(ra1); // time to reset only shrinks
  });
});

describe("reset requests — 3 per hour per email AND 10 per hour per IP", () => {
  it("admits 3 per email, 429s the 4th for the SAME address", async () => {
    const email = "reset-throttle@example.com";
    for (let i = 0; i < 3; i += 1) {
      expect((await requestReset(email)).status).toBe(200);
    }
    await expectRateLimited((await requestReset(email)) as never);
  });

  it("the per-email limit applies to UNKNOWN addresses too (no enumeration)", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await requestReset("ghost@example.com")).status).toBe(200);
    }
    const res = await requestReset("ghost@example.com");
    expect(res.status).toBe(429);
  });

  it("admits 10 per IP across different emails, 429s the 11th", async () => {
    // 3 + 3 + 3 = 9 requests over three addresses (each email at its cap).
    for (let i = 0; i < 3; i += 1) {
      expect((await requestReset("r0@example.com")).status).toBe(200);
      expect((await requestReset("r1@example.com")).status).toBe(200);
      expect((await requestReset("r2@example.com")).status).toBe(200);
    }
    // 10th from this IP with a fresh email address: still allowed.
    expect((await requestReset("r3@example.com")).status).toBe(200);
    // 11th — the IP dimension rejects (email dimension fresh).
    await expectRateLimited((await requestReset("r4@example.com")) as never);
  });
});

describe("session endpoint — 120 requests per minute per IP", () => {
  it("admits 120, 429s the 121st (cookie-less 401s inside the budget)", async () => {
    for (let i = 0; i < 120; i += 1) {
      const res = await getSession();
      expect(res.status).toBe(401); // no cookie — but the attempt counts
    }
    await expectRateLimited((await getSession()) as never);
  });
});
