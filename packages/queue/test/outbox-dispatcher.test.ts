import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutboxDispatcher, type OutboxHandlerEvent } from "../src/index";
import {
  fetchEventRow,
  setupQueueTest,
  teardownQueueTest,
  type QueueTestContext,
} from "./setup";

/**
 * Outbox dispatcher suites (ticket 05): real roles, real Postgres.
 *
 * app_user PROVES the INSERT-only contract (no RETURNING); worker_user runs
 * the dispatcher. Covers: processing, retry/backoff, dead-letter after 10
 * attempts, SKIP LOCKED concurrency, and the restart-safety + idempotency
 * contract.
 */

const WORKSPACE_CREATED = "workspace.created";

let ctx: QueueTestContext;

beforeAll(async () => {
  ctx = await setupQueueTest();
});

// Exact-count assertions need a clean scan; worker_user has no DELETE, so the
// admin connection does the wiping.
beforeEach(async () => {
  await ctx.clearOutbox();
});

afterAll(async () => {
  await teardownQueueTest(ctx);
});

async function countEffects(id: string): Promise<number> {
  const res = await ctx.workerPool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM app.outbox_test_effects WHERE event_id = $1",
    [id],
  );
  return Number(res.rows[0]!.n);
}

describe("outbox_events role contract (migration 0003)", () => {
  it("app_user INSERTs without RETURNING; RETURNING and SELECT fail with 42501", async () => {
    const id = await ctx.insertEvent(WORKSPACE_CREATED, {
      workspaceId: "00000000-0000-0000-0000-000000000001",
      userId: "00000000-0000-0000-0000-000000000002",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // RETURNING would need SELECT — app_user has INSERT only.
    await expect(
      ctx.appPool.query(
        `INSERT INTO app.outbox_events (id, event_type, payload)
         VALUES ($1, 'x', '{}'::jsonb) RETURNING id`,
        ["00000000-0000-0000-0000-000000000003"],
      ),
    ).rejects.toHaveProperty("code", "42501");

    await expect(
      ctx.appPool.query("SELECT count(*) FROM app.outbox_events"),
    ).rejects.toHaveProperty("code", "42501");

    // worker_user (dispatcher role) CAN read the outbox.
    const res = await ctx.workerPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app.outbox_events WHERE id = $1",
      [id],
    );
    expect(Number(res.rows[0]!.n)).toBe(1);
  });
});

describe("dispatcher: processing", () => {
  it("hands available events to the registered handler and marks processed_at", async () => {
    const handled: OutboxHandlerEvent[] = [];
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: async (event) => {
          handled.push(event);
        },
      },
    });

    const a = await ctx.insertEvent(WORKSPACE_CREATED, {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
    });
    const b = await ctx.insertEvent(WORKSPACE_CREATED, {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      userId: "22222222-2222-4222-8222-222222222222",
    });
    // Not yet available — must NOT be claimed this tick.
    const later = await ctx.insertEvent(
      WORKSPACE_CREATED,
      { workspaceId: "44444444-4444-4444-8444-444444444444" },
      { availableAtSql: "now() + interval '1 hour'" },
    );

    const outcome = await dispatcher.dispatchOnce();
    expect(outcome).toMatchObject({ claimed: 2, processed: 2, retried: 0, deadLettered: 0 });

    expect(handled.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(handled[0]!.payload.workspaceId).toBeTypeOf("string");
    expect(handled[0]!.eventType).toBe(WORKSPACE_CREATED);

    const rowA = await fetchEventRow(ctx.workerPool, a);
    expect(rowA!.processed_at).not.toBeNull();
    expect(rowA!.dispatched_at).not.toBeNull();
    expect(rowA!.attempts).toBe(0);
    // Available rows are skipped only while unavailable…
    const rowLater = await fetchEventRow(ctx.workerPool, later);
    expect(rowLater!.processed_at).toBeNull();

    // …and processed rows never re-claim.
    const second = await dispatcher.dispatchOnce();
    expect(second.claimed).toBe(0);
  });

  it("event types without a registered handler retry with backoff and dead-letter", async () => {
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {},
      backoffMs: () => 500,
    });
    const id = await ctx.insertEvent("unknown.event", {});
    const outcome = await dispatcher.dispatchOnce();
    expect(outcome.retried).toBe(1);
    const row = await fetchEventRow(ctx.workerPool, id);
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toMatch(/no handler registered/);
    // Force it to the threshold, then prove the dead-letter.
    await ctx.workerPool.query(
      "UPDATE app.outbox_events SET attempts = 9, available_at = now() WHERE id = $1",
      [id],
    );
    const second = await dispatcher.dispatchOnce();
    expect(second.deadLettered).toBe(1);
    const dead = await fetchEventRow(ctx.workerPool, id);
    expect(dead!.dead_lettered_at).not.toBeNull();
    expect(dead!.attempts).toBe(10);
  });
});

describe("dispatcher: retry, backoff, dead-letter", () => {
  it("increments attempts, records last_error and pushes available_at on failure", async () => {
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: () => {
          throw new Error("handler boom");
        },
      },
    });
    const id = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "x" });

    const outcome = await dispatcher.dispatchOnce();
    expect(outcome).toMatchObject({ claimed: 1, processed: 0, retried: 1 });

    const row = await fetchEventRow(ctx.workerPool, id);
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("handler boom");
    expect(row!.processed_at).toBeNull();
    expect(row!.dead_lettered_at).toBeNull();
    const availableAt = new Date(row!.available_at).getTime();
    const now = Date.now();
    // default backoff after attempt 1 = 1s (± scheduling slack)
    expect(availableAt).toBeGreaterThanOrEqual(now - 1_000);
    expect(availableAt).toBeLessThanOrEqual(now + 5_000);
  });

  it("applies exponential backoff (1s·2^(n-1), capped at 10 min)", async () => {
    const { defaultBackoffMs } = await import("../src/index");
    expect(defaultBackoffMs(1)).toBe(1_000);
    expect(defaultBackoffMs(2)).toBe(2_000);
    expect(defaultBackoffMs(5)).toBe(16_000);
    expect(defaultBackoffMs(15)).toBe(600_000);
  });

  it("dead-letters after 10 failed attempts (spec)", async () => {
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: () => {
          throw new Error("permanent failure");
        },
      },
    });
    const id = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "dl" });

    let outcome = { deadLettered: 0 };
    for (let attempt = 1; attempt <= 9; attempt++) {
      // Retry availability is immediate for the test (backoff pushed forward
      // after each failure); pull the row back to now() before each tick.
      await ctx.workerPool.query(
        "UPDATE app.outbox_events SET available_at = now() WHERE id = $1",
        [id],
      );
      outcome = await dispatcher.dispatchOnce();
      expect(outcome.deadLettered).toBe(0);
    }
    const before = await fetchEventRow(ctx.workerPool, id);
    expect(before!.attempts).toBe(9);

    await ctx.workerPool.query(
      "UPDATE app.outbox_events SET available_at = now() WHERE id = $1",
      [id],
    );
    outcome = await dispatcher.dispatchOnce();
    expect(outcome.deadLettered).toBe(1);

    const row = await fetchEventRow(ctx.workerPool, id);
    expect(row!.attempts).toBe(10);
    expect(row!.dead_lettered_at).not.toBeNull();
    expect(row!.processed_at).toBeNull();

    // Dead-lettered rows leave the dispatch scan entirely.
    const idle = await dispatcher.dispatchOnce();
    expect(idle.claimed).toBe(0);
  });

  it("mixes success and failure in one batch atomically", async () => {
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: (event) => {
          if (event.payload.workspaceId === "fail") {
            throw new Error("partial batch failure");
          }
        },
      },
    });
    const ok = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "ok" });
    const bad = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "fail" });

    const outcome = await dispatcher.dispatchOnce();
    expect(outcome).toMatchObject({ claimed: 2, processed: 1, retried: 1 });
    expect((await fetchEventRow(ctx.workerPool, ok))!.processed_at).not.toBeNull();
    expect((await fetchEventRow(ctx.workerPool, bad))!.attempts).toBe(1);
  });
});

describe("dispatcher: SKIP LOCKED concurrency + restart safety", () => {
  it("a second dispatcher skips rows locked by an uncommitted claim and processes OTHER events", async () => {
    const handled: string[] = [];
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: { [WORKSPACE_CREATED]: (e) => void handled.push(e.id) },
    });

    const locked = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "locked" });
    const free = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "free" });

    // "Dispatcher #1" mid-flight: transaction open, claim taken, NO commit.
    const client1 = await ctx.workerPool.connect();
    await client1.query("BEGIN");
    await client1.query(
      `SELECT id FROM app.outbox_events
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );

    try {
      // Dispatcher #2 must claim the OTHER event, never block on #1's row.
      const outcome = await dispatcher.dispatchOnce();
      expect(outcome.claimed).toBe(1);
      expect(handled).toEqual([free]);
    } finally {
      await client1.query("ROLLBACK");
      client1.release();
    }

    // #1's row was never processed (its tx rolled back) — the next tick gets it.
    expect(await fetchEventRow(ctx.workerPool, locked)).toMatchObject({
      processed_at: null,
      attempts: 0,
    });
    const next = await dispatcher.dispatchOnce();
    expect(next.claimed).toBe(1);
    expect(handled.sort()).toEqual([free, locked].sort());
    expect(await countEffects(locked)).toBe(0);
  });

  it("restart mid-dispatch: killed connection rolls the claim back; redelivery applies the handler effect exactly once", async () => {
    const invocations: string[] = [];
    let releaseBlocked: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });

    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      // Idempotency contract in action: unique-constraint + ON CONFLICT DO
      // NOTHING — replaying the event must not duplicate the effect.
      handlers: {
        [WORKSPACE_CREATED]: async (event) => {
          invocations.push(event.id);
          await ctx.workerPool.query(
            `INSERT INTO app.outbox_test_effects (event_id, note)
             VALUES ($1, 'workspace-created-effect')
             ON CONFLICT (event_id) DO NOTHING`,
            [event.id],
          );
          await blocked; // worker "crashes" while the claim tx is open
        },
      },
    });

    const id = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "restart" });

    const firstDispatch = dispatcher.dispatchOnce().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    // Wait until the handler is inside the open claim transaction.
    for (let i = 0; i < 100 && invocations.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(invocations).toEqual([id]);

    // Simulate the worker dying: kill the backend holding the claim.
    const victims = await ctx.admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'idle in transaction'
          AND query ILIKE '%outbox_events%'`,
    );
    expect(victims.rows.length).toBe(1);
    await ctx.admin.query("SELECT pg_terminate_backend($1)", [
      victims.rows[0]!.pid,
    ]);

    releaseBlocked!();
    const result = await firstDispatch;
    expect(result).toBe("rejected"); // tick failed — nothing committed

    const afterCrash = await fetchEventRow(ctx.workerPool, id);
    expect(afterCrash!.processed_at).toBeNull(); // event NOT lost, NOT processed

    // A restarted worker redelivers; the idempotent handler no-ops.
    const restarted = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: async (event) => {
          invocations.push(event.id);
          await ctx.workerPool.query(
            `INSERT INTO app.outbox_test_effects (event_id, note)
             VALUES ($1, 'workspace-created-effect')
             ON CONFLICT (event_id) DO NOTHING`,
            [event.id],
          );
        },
      },
    });
    const outcome = await restarted.dispatchOnce();
    expect(outcome.processed).toBe(1);

    const row = await fetchEventRow(ctx.workerPool, id);
    expect(row!.processed_at).not.toBeNull();
    expect(invocations.filter((x) => x === id).length).toBe(2); // redelivered once
    expect(await countEffects(id)).toBe(1); // …but the effect happened ONCE
  });

  it("handler contract test: same event dispatched twice applies the effect once", async () => {
    const dispatcher = createOutboxDispatcher({
      pool: ctx.workerPool,
      handlers: {
        [WORKSPACE_CREATED]: async (event) => {
          await ctx.workerPool.query(
            `INSERT INTO app.outbox_test_effects (event_id, note)
             VALUES ($1, 'once-only')
             ON CONFLICT (event_id) DO NOTHING`,
            [event.id],
          );
        },
      },
    });
    const id = await ctx.insertEvent(WORKSPACE_CREATED, { workspaceId: "twice" });

    await dispatcher.dispatchOnce();
    // Simulate at-least-once redelivery (e.g. claim rollback upstream).
    await ctx.workerPool.query(
      "UPDATE app.outbox_events SET processed_at = NULL, dispatched_at = NULL WHERE id = $1",
      [id],
    );
    await dispatcher.dispatchOnce();

    const row = await fetchEventRow(ctx.workerPool, id);
    expect(row!.processed_at).not.toBeNull();
    expect(await countEffects(id)).toBe(1); // unique constraint kept it single
  });
});
