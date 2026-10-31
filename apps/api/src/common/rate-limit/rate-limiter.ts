/**
 * In-memory fixed-window rate limiter (spec: "The limiter is in-memory for
 * the single-process alpha and moves to shared storage at beta").
 *
 * Properties:
 * - **Fixed windows with lazy expiry.** Each key holds
 *   `{ count, windowStart, windowMs }`; a check that arrives after
 *   `windowStart + windowMs` starts a fresh window in place. No timers, no
 *   background sweeper — expiry happens on access.
 * - **Every attempt counts.** Rejected attempts still consume a slot of the
 *   current window (re-checking cannot extend the window; it simply cannot
 *   sneak past the limit either).
 * - **Memory-bounded by design** (3.6 GB RAM environment): tracked keys are
 *   capped at `maxKeys` (default 50,000 — a few MB worst case). Before a new
 *   key is inserted at capacity the limiter first prunes every expired
 *   window; if the map is still full it evicts the windows that expire
 *   soonest (deterministic, bounded, O(n) scan in the rare saturated case).
 *   An attacker rotating unlimited source keys can evict other clients'
 *   windows early (a mild availability trade-off inherent to bounded
 *   in-memory limits) but can never exceed the cap or grow the process.
 * - **Per-process only.** Horizontal replicas would each keep their own
 *   windows; the alpha is a single process, and the beta move to shared
 *   storage is tracked in ADR-0004.
 */

/** Discriminated result of a limiter check. */
export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; retryAfterSec: number };

interface WindowEntry {
  count: number;
  windowStart: number;
  windowMs: number;
}

export interface RateLimiterOptions {
  /** Maximum tracked keys. Oldest-expiring windows are evicted beyond it. */
  maxKeys?: number;
  /** Injectable clock (defaults to `Date.now`; vitest fake timers also work). */
  now?: () => number;
}

/** Default key cap: 50k keys ≈ a few MB — safe on a 3.6 GB free-tier box. */
export const DEFAULT_MAX_TRACKED_KEYS = 50_000;

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error(`maxKeys must be a positive integer (got ${this.maxKeys})`);
    }
    this.now = options.now ?? Date.now;
  }

  /** Number of keys currently tracked (before lazy expiry). */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Records one attempt against `key` and decides the fixed window
   * `limit` per `windowMs`. The 5th attempt of a 5-per-hour limit is `ok`
   * with `remaining: 0`; the 6th is rejected with `retryAfterSec` (seconds
   * until the window resets, minimum 1 — the `Retry-After` header value).
   */
  check(key: string, limit: number, windowMs: number): RateLimitResult {
    assertPositiveInt(limit, "limit");
    assertPositiveInt(windowMs, "windowMs");
    const now = this.now();

    let entry = this.windows.get(key);
    if (entry === undefined || now - entry.windowStart >= entry.windowMs) {
      // Lazy expiry: an exhausted-but-expired window frees its key in place.
      this.ensureCapacity();
      entry = { count: 0, windowStart: now, windowMs };
      this.windows.set(key, entry);
    }

    entry.count += 1;
    const resetAt = entry.windowStart + entry.windowMs;
    if (entry.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    return { ok: true, remaining: limit - entry.count, resetAt };
  }

  /**
   * Drops every expired window immediately and returns how many were
   * removed. Called internally at capacity; exposed for tests and for an
   * optional periodic sweep by the host process.
   */
  prune(now: number = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= entry.windowMs) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Clears all tracked windows (tests / administrative reset). */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Bounds memory before a new key is inserted: prune expired windows first,
   * then evict soonest-expiring survivors while at capacity.
   */
  private ensureCapacity(): void {
    if (this.windows.size < this.maxKeys) return;
    this.prune();
    while (this.windows.size >= this.maxKeys) {
      let victimKey: string | undefined;
      let victimResetAt = Infinity;
      for (const [key, entry] of this.windows) {
        const resetAt = entry.windowStart + entry.windowMs;
        if (resetAt < victimResetAt) {
          victimResetAt = resetAt;
          victimKey = key;
        }
      }
      if (victimKey === undefined) break;
      this.windows.delete(victimKey);
    }
  }
}

/**
 * Builds a namespaced limiter key from parts (joined with `:`). Empty parts
 * are dropped so `["signin", "", ip]` and `["signin", ip]` can never collapse
 * into ambiguous keys like `signin::1.2.3.4`.
 */
export function keyFor(parts: readonly string[]): string {
  return parts.filter((part) => part !== "" && part !== undefined && part !== null).join(":");
}
