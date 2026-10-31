import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keyFor,
  PUBLIC_SESSION_PER_HOUR_PER_FORM,
  PUBLIC_SESSION_PER_HOUR_PER_IP,
  RATE_LIMITED_I18N_KEY,
  RATE_LIMITED_PROBLEM_TYPE,
  RATE_LIMIT_RULES,
  rateLimited,
  RateLimiter,
  RESET_PER_HOUR_PER_EMAIL,
  RESET_PER_HOUR_PER_IP,
  SESSION_PER_MINUTE_PER_IP,
  SIGNIN_PER_15MIN_PER_EMAIL,
  SIGNIN_PER_15MIN_PER_IP,
  SIGNUP_PER_HOUR_PER_IP,
} from "../src/common/rate-limit";

describe("RateLimiter — fixed window", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    limiter = new RateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows exactly `limit` attempts then rejects (5th ok, 6th rejected)", () => {
    for (let i = 1; i <= 5; i += 1) {
      const result = limiter.check("signup:ip:198.51.100.7", 5, 3_600_000);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.remaining).toBe(5 - i);
    }
    const rejected = limiter.check("signup:ip:198.51.100.7", 5, 3_600_000);
    expect(rejected).toEqual({ ok: false, retryAfterSec: 3600 });
  });

  it("resets after the window passes (lazy expiry via fake timers)", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check("k", 3, 60_000).ok).toBe(true);
    }
    expect(limiter.check("k", 3, 60_000).ok).toBe(false);

    vi.advanceTimersByTime(59_999);
    expect(limiter.check("k", 3, 60_000).ok).toBe(false);

    vi.advanceTimersByTime(1);
    const fresh = limiter.check("k", 3, 60_000);
    expect(fresh).toEqual({ ok: true, remaining: 2, resetAt: 120_000 });
  });

  it("reports resetAt as windowStart + windowMs and precise retryAfterSec", () => {
    const first = limiter.check("k", 1, 60_000);
    expect(first).toEqual({ ok: true, remaining: 0, resetAt: 60_000 });

    vi.advanceTimersByTime(30_000);
    const rejected = limiter.check("k", 1, 60_000);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.retryAfterSec).toBe(30);
  });

  it("counts rejected attempts against the current window", () => {
    for (let i = 0; i < 10; i += 1) {
      limiter.check("k", 5, 60_000);
    }
    expect(limiter.check("k", 5, 60_000).ok).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(limiter.check("k", 5, 60_000).ok).toBe(true);
  });

  it("keys are independent", () => {
    for (let i = 0; i < 5; i += 1) limiter.check("a", 5, 60_000);
    expect(limiter.check("a", 5, 60_000).ok).toBe(false);
    expect(limiter.check("b", 5, 60_000)).toEqual({ ok: true, remaining: 4, resetAt: 60_000 });
  });

  it("supports an injectable clock instead of fake timers", () => {
    let now = 1_000;
    const manual = new RateLimiter({ now: () => now });
    for (let i = 0; i < 2; i += 1) manual.check("k", 2, 500);
    expect(manual.check("k", 2, 500).ok).toBe(false);
    now = 1_501; // window [1000, 1500) has passed
    expect(manual.check("k", 2, 500).ok).toBe(true);
  });

  it("validates its inputs", () => {
    expect(() => limiter.check("k", 0, 60_000)).toThrow(/limit/);
    expect(() => limiter.check("k", 5, 0)).toThrow(/windowMs/);
    expect(() => limiter.check("k", 1.5, 60_000)).toThrow(/limit/);
    expect(() => new RateLimiter({ maxKeys: 0 })).toThrow(/maxKeys/);
  });
});

describe("RateLimiter — memory bounds (3.6 GB environment)", () => {
  it("prunes expired windows when at capacity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter({ maxKeys: 3 });
    for (const key of ["a", "b", "c"]) limiter.check(key, 1, 10_000);
    expect(limiter.size).toBe(3);

    vi.advanceTimersByTime(20_000); // every window is now expired
    expect(limiter.prune()).toBe(3);
    expect(limiter.size).toBe(0);

    limiter.check("d", 1, 10_000);
    expect(limiter.size).toBe(1);
    vi.useRealTimers();
  });

  it("lazy expiry reuses an expired key's slot without growing the map", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter({ maxKeys: 3 });
    limiter.check("a", 1, 10_000);
    vi.advanceTimersByTime(11_000);
    limiter.check("a", 1, 10_000); // fresh window in place, not a new entry
    expect(limiter.size).toBe(1);
    vi.useRealTimers();
  });

  it("never exceeds maxKeys and evicts the soonest-expiring window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter({ maxKeys: 2 });
    limiter.check("short", 1, 10_000); // resetAt 10_000 — evicted first
    limiter.check("long", 1, 100_000); // resetAt 100_000

    limiter.check("third", 1, 50_000); // full → prune (nothing expired) → evict "short"
    expect(limiter.size).toBe(2);
    expect(limiter.check("long", 1, 100_000).ok).toBe(false); // still at its limit
    expect(limiter.check("short", 1, 10_000).ok).toBe(true); // evicted → fresh window

    // Sustained key rotation can never grow the map past the cap.
    for (let i = 0; i < 50; i += 1) limiter.check(`rotating:${i}`, 1, 60_000);
    expect(limiter.size).toBe(2);
    vi.useRealTimers();
  });

  it("default cap is 50,000 tracked keys", async () => {
    const { DEFAULT_MAX_TRACKED_KEYS } = await import("../src/common/rate-limit");
    expect(DEFAULT_MAX_TRACKED_KEYS).toBe(50_000);
    expect(new RateLimiter().size).toBe(0);
  });

  it("reset() clears everything", () => {
    const limiter = new RateLimiter();
    limiter.check("a", 5, 60_000);
    limiter.check("b", 5, 60_000);
    limiter.reset();
    expect(limiter.size).toBe(0);
    expect(limiter.check("a", 5, 60_000)).toEqual({ ok: true, remaining: 4, resetAt: expect.any(Number) });
  });
});

describe("keyFor", () => {
  it("joins parts with ':'", () => {
    expect(keyFor(["signin", "ip", "198.51.100.7"])).toBe("signin:ip:198.51.100.7");
    expect(keyFor(["signin", "email", "user@example.com"])).toBe("signin:email:user@example.com");
  });

  it("drops empty parts so namespacing stays unambiguous", () => {
    expect(keyFor(["signin", "", "ip"])).toBe("signin:ip");
    expect(keyFor(["", "a", ""])).toBe("a");
    expect(keyFor([])).toBe("");
  });

  it("namespaces per-scope keys so different windows never collide", () => {
    const ip = "198.51.100.7";
    expect(keyFor(["signup", "ip", ip])).not.toBe(keyFor(["session", "ip", ip]));
    expect(keyFor(["signin", "ip", ip])).not.toBe(keyFor(["signin", "email", ip]));
  });
});

describe("limit constants (spec §auth hardening)", () => {
  const HOUR = 3_600_000;
  const FIFTEEN_MIN = 900_000;

  it("matches the spec's numbers exactly", () => {
    expect(SIGNUP_PER_HOUR_PER_IP).toEqual({ limit: 5, windowMs: HOUR });
    expect(SIGNIN_PER_15MIN_PER_IP).toEqual({ limit: 10, windowMs: FIFTEEN_MIN });
    expect(SIGNIN_PER_15MIN_PER_EMAIL).toEqual({ limit: 10, windowMs: FIFTEEN_MIN });
    expect(RESET_PER_HOUR_PER_EMAIL).toEqual({ limit: 3, windowMs: HOUR });
    expect(RESET_PER_HOUR_PER_IP).toEqual({ limit: 10, windowMs: HOUR });
    expect(SESSION_PER_MINUTE_PER_IP).toEqual({ limit: 120, windowMs: 60_000 });
    expect(PUBLIC_SESSION_PER_HOUR_PER_IP).toEqual({ limit: 30, windowMs: HOUR });
    expect(PUBLIC_SESSION_PER_HOUR_PER_FORM).toEqual({ limit: 30, windowMs: HOUR });
  });

  it("aggregates every rule under its wiring name", () => {
    expect(Object.keys(RATE_LIMIT_RULES)).toEqual([
      "SIGNUP_PER_HOUR_PER_IP",
      "SIGNIN_PER_15MIN_PER_IP",
      "SIGNIN_PER_15MIN_PER_EMAIL",
      "RESET_PER_HOUR_PER_EMAIL",
      "RESET_PER_HOUR_PER_IP",
      "SESSION_PER_MINUTE_PER_IP",
      "PUBLIC_SESSION_PER_HOUR_PER_IP",
      "PUBLIC_SESSION_PER_HOUR_PER_FORM",
    ]);
  });

  it("drives the real limiter end-to-end (5/hour signup example)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter();
    const key = keyFor(["signup", "ip", "198.51.100.7"]);
    for (let i = 0; i < SIGNUP_PER_HOUR_PER_IP.limit; i += 1) {
      expect(limiter.check(key, SIGNUP_PER_HOUR_PER_IP.limit, SIGNUP_PER_HOUR_PER_IP.windowMs).ok).toBe(true);
    }
    const rejected = limiter.check(key, SIGNUP_PER_HOUR_PER_IP.limit, SIGNUP_PER_HOUR_PER_IP.windowMs);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const { problem, retryAfterSec } = rateLimited(rejected.retryAfterSec);
      expect(retryAfterSec).toBe(3600);
      expect(problem).toEqual({
        type: RATE_LIMITED_PROBLEM_TYPE,
        title: "Too Many Requests",
        status: 429,
        code: "rate_limited",
        detail: RATE_LIMITED_I18N_KEY,
      });
    }
    vi.useRealTimers();
  });
});

describe("rateLimited — 429 Problem-Details factory", () => {
  it("returns the stable rate_limited body and Retry-After value", () => {
    const { problem, retryAfterSec } = rateLimited(42.4);
    expect(problem.status).toBe(429);
    expect(problem.code).toBe("rate_limited");
    expect(problem.title).toBe("Too Many Requests");
    expect(problem.type).toBe("https://form.example/errors/rate_limited");
    expect(problem.detail).toBe("errors.rateLimited.title"); // i18n key, not copy
    expect(retryAfterSec).toBe(43); // ceil for the Retry-After header
  });

  it("never returns a non-positive Retry-After", () => {
    expect(rateLimited(0).retryAfterSec).toBe(1);
    expect(rateLimited(0.1).retryAfterSec).toBe(1);
  });
});
