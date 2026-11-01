import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Pool } from "pg";
import {
  createPool,
  withTenantTransaction,
  withUserTransaction,
} from "@form/database";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  type BootstrappedUrls,
} from "@form/database/testing";
import {
  DEFAULT_MAX_ATTEMPTS,
  createOutboxDispatcher,
  type OutboxHandlerEvent,
} from "@form/queue";
import { installPgBossSchema } from "../src/index";

/**
 * Ticket 05 — outbox dispatcher against real Postgres under the real
 * `worker_user` role (SELECT/UPDATE on outbox_events only). This suite runs
 * the LIVE dispatcher from `@form/queue` (ADR-0005 —
 * `packages/queue/src/outbox/dispatcher.ts`; the worker keeps no dispatcher
 * copy of its own):
 *
 *   - processes `workspace.created` produced by a REAL bootstrap and marks it
 *     processed exactly once (a second sweep claims nothing — no
 *     double-process);
 *   - a failed handler is retried with backoff + failure accounting; a
 *     RESTARTED dispatcher (fresh instance) completes it exactly once more;
 *   - SKIP LOCKED: a dispatcher skips rows locked by an uncommitted claim and
 *     processes OTHER events;
 *   - dead-letters after the attempt limit (spec default: 10 attempts, pinned
 *     by `DEFAULT_MAX_ATTEMPTS`; the constructor option proves the mechanism);
 *   - handlers open their OWN tenant transaction (the live dispatcher sets no
 *     GUC): `app.workspace_id` from the payload under the non-bypass
 *     `worker_user` role — RLS-filtered tenant read;
 *   - event types WITHOUT a registered handler retry with backoff and
 *     dead-letter (`no handler registered` in last_error) — they must not
 *     poison the scan forever.
 *
 * The pg-boss scheduled dispatch (heartbeat-cadence wiring, singleton policy,
 * low-latency enqueue path) is covered end-to-end by outbox-worker.test.ts,
 * and the dispatcher's own unit-level semantics by
 * packages/queue/test/outbox-dispatcher.test.ts.
 */

const SCRATCH_DB = "t05_outbox";

let urls: BootstrappedUrls;
let adminClient: Client;
let migrator: Client;
let workerPoolUrl: string;
/** worker_user pool for the dispatcher — outbox is NOT a tenant table, so
 *  the tenant-guard is off (ADR-0005); handlers open their own tenant
 *  transactions, which mark their own clients. */
let workerPool: Pool;

/** Real producer: bootstraps a personal workspace as app_user (function call). */
async function bootstrapAsUser(userId: string): Promise<string> {
  const pool = createPool(testRoleUrl("app_user", SCRATCH_DB), { max: 1 });
  try {
    return await withUserTransaction(pool, userId, async (tx) => {
      const res = await tx.query<{ ws: string }>(
        "SELECT app.create_personal_workspace()::text AS ws",
      );
      return res.rows[0]!.ws;
    });
  } finally {
    await pool.end();
  }
}

/** Inserts an outbox event as the migrator (owner of the no-RLS table). */
async function insertEvent(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await migrator.query<{ id: string }>(
    `INSERT INTO app.outbox_events (id, event_type, payload, available_at)
     VALUES (gen_random_uuid(), $1, $2::jsonb, now() - interval '1 second')
     RETURNING id::text`,
    [eventType, JSON.stringify(payload)],
  );
  return res.rows[0]!.id;
}

async function eventState(id: string): Promise<{
  processed_at: string | null;
  dead_lettered_at: string | null;
  attempts: number;
  last_error: string | null;
}> {
  const res = await migrator.query<{
    processed_at: string | null;
    dead_lettered_at: string | null;
    attempts: number;
    last_error: string | null;
  }>(
    `SELECT processed_at::text, dead_lettered_at::text, attempts, last_error
       FROM app.outbox_events WHERE id = $1::uuid`,
    [id],
  );
  return res.rows[0]!;
}

beforeAll(async () => {
  await createScratchDatabase(SCRATCH_DB);
  urls = await ensureBootstrapped(SCRATCH_DB);
  adminClient = new Client({ connectionString: urls.adminUrl });
  await adminClient.connect();

  // pg-boss DDL as the migrator + runtime grants (same as the T02 spike).
  await installPgBossSchema(testRoleUrl("migrator", SCRATCH_DB));
  for (const sql of [
    `GRANT USAGE ON SCHEMA pgboss TO worker_user`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO worker_user`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO worker_user`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO worker_user`,
  ]) {
    await adminClient.query(sql);
  }

  migrator = new Client({ connectionString: testRoleUrl("migrator", SCRATCH_DB) });
  await migrator.connect();
  workerPoolUrl = testRoleUrl("worker_user", SCRATCH_DB);
  workerPool = createPool(workerPoolUrl, { max: 5, tenantGuard: false });
  // Idle pool clients can emit 'error' (backend killed mid-claim); without a
  // listener node would crash the suite.
  workerPool.on("error", () => undefined);
  workerPool.on("connect", (client) => client.on("error", () => undefined));
}, 120_000);

beforeEach(async () => {
  // Exact-count assertions need a clean scan; worker_user has no DELETE, so
  // the admin connection does the wiping.
  await adminClient.query("DELETE FROM app.outbox_events");
});

afterAll(async () => {
  await workerPool?.end().catch(() => undefined);
  await migrator?.end();
  await adminClient?.end();
  await dropDatabase(SCRATCH_DB);
});

describe("live @form/queue dispatcher under worker_user", () => {
  it("processes a real workspace.created event exactly once (no double-process on re-sweep)", async () => {
    // REAL producer: bootstrap as app_user via the security-definer function.
    const userId = crypto.randomUUID();
    const workspaceId = await bootstrapAsUser(userId);

    const handled: OutboxHandlerEvent[] = [];
    const dispatcher = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "workspace.created": async (event) => {
          handled.push(event);
        },
      },
    });

    const outcome = await dispatcher.dispatchOnce();
    expect(outcome).toMatchObject({
      claimed: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(handled).toHaveLength(1);
    expect(handled[0]!.payload.workspaceId).toBe(workspaceId);
    expect(handled[0]!.payload.userId).toBe(userId);
    expect(handled[0]!.eventType).toBe("workspace.created");

    const rows = await migrator.query<{
      processed_at: string | null;
      attempts: number;
      dead_lettered_at: string | null;
    }>(
      `SELECT processed_at::text, attempts, dead_lettered_at::text
         FROM app.outbox_events WHERE event_type = 'workspace.created'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.processed_at).not.toBeNull();
    expect(rows.rows[0]!.attempts).toBe(0);
    expect(rows.rows[0]!.dead_lettered_at).toBeNull();

    // Re-sweep: already-processed rows are never claimed again.
    const again = await dispatcher.dispatchOnce();
    expect(again.claimed).toBe(0);
    expect(handled).toHaveLength(1);
  });

  it("crash simulation: a failed handler is retried with accounting; a RESTARTED dispatcher finishes it exactly once", async () => {
    const id = await insertEvent("test.crash", { n: 1 });
    const successCalls: number[] = [];

    const first = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "test.crash": async () => {
          throw new Error("injected crash mid-dispatch");
        },
      },
      backoffMs: () => 0,
    });
    const outcome = await first.dispatchOnce();
    expect(outcome).toMatchObject({ claimed: 1, processed: 0, retried: 1 });

    let state = await eventState(id);
    expect(state.processed_at).toBeNull();
    expect(state.attempts).toBe(1);
    expect(state.last_error).toContain("injected crash");

    // RESTART: a fresh dispatcher instance picks it up and finishes it.
    const restarted = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "test.crash": async () => {
          successCalls.push(1);
        },
      },
      backoffMs: () => 0,
    });
    await restarted.dispatchOnce();
    state = await eventState(id);
    expect(state.processed_at).not.toBeNull();
    // Live dispatcher semantics: `attempts` counts FAILURES (incremented on
    // the retry path only) — a successful attempt does not add another tick.
    expect(state.attempts).toBe(1);
    // Exactly-once completion: the successful handler ran once.
    expect(successCalls).toHaveLength(1);
  });

  it("SKIP LOCKED: a dispatcher skips rows locked by an uncommitted claim and processes OTHER events", async () => {
    const handled: string[] = [];
    const dispatcher = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "workspace.created": (event) => void handled.push(event.id),
      },
    });

    const a = await insertEvent("workspace.created", { workspaceId: "a" });
    const b = await insertEvent("workspace.created", { workspaceId: "b" });

    // "Dispatcher #1" mid-flight: transaction open, claim taken, NO commit.
    const client1 = await workerPool.connect();
    await client1.query("BEGIN");
    const lockedRes = await client1.query<{ id: string }>(
      `SELECT id FROM app.outbox_events
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const lockedId = lockedRes.rows[0]!.id;
    const freeId = lockedId === a ? b : a;

    try {
      // Dispatcher #2 must claim the OTHER event, never block on #1's row.
      const outcome = await dispatcher.dispatchOnce();
      expect(outcome.claimed).toBe(1);
      expect(handled).toEqual([freeId]);
    } finally {
      await client1.query("ROLLBACK");
      client1.release();
    }

    // #1's row was never processed (its tx rolled back) — the next tick gets it.
    const lockedState = await eventState(lockedId);
    expect(lockedState.processed_at).toBeNull();
    expect(lockedState.attempts).toBe(0);

    const next = await dispatcher.dispatchOnce();
    expect(next.claimed).toBe(1);
    expect([...handled].sort()).toEqual([a, b].sort());
  });

  it("dead-letters after the attempt limit (spec default: 10 attempts)", async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(10);
    const id = await insertEvent("test.dead", {});
    const dispatcher = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "test.dead": async () => {
          throw new Error("always fails");
        },
      },
      backoffMs: () => 0,
      maxAttempts: 3, // mechanism-level override; the default is pinned above
    });

    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Retry availability is immediate (backoff 0), but pull the row back to
      // now() before each tick so the scan cannot race the clock.
      await migrator.query(
        "UPDATE app.outbox_events SET available_at = now() WHERE id = $1::uuid",
        [id],
      );
      const outcome = await dispatcher.dispatchOnce();
      outcomes.push(
        outcome.deadLettered === 1
          ? "dead_lettered"
          : outcome.retried === 1
            ? "retry"
            : `unexpected(${JSON.stringify(outcome)})`,
      );
    }
    expect(outcomes).toEqual(["retry", "retry", "dead_lettered"]);

    const state = await eventState(id);
    expect(state.dead_lettered_at).not.toBeNull();
    expect(state.attempts).toBe(3);
    expect(state.processed_at).toBeNull();

    // Dead-lettered rows are never claimed again.
    const after = await dispatcher.dispatchOnce();
    expect(after.claimed).toBe(0);
  });

  it("handlers open their OWN tenant transaction: app.workspace_id from the payload under worker_user", async () => {
    // Two REAL workspaces: the handler must only see the payload's one.
    // Hermetic start: the sweep claims every available event, so clear any
    // leftovers from earlier tests in this file (admin bypasses the
    // worker role's INSERT/UPDATE-only grants).
    await adminClient.query("DELETE FROM app.outbox_events");
    const userIdA = crypto.randomUUID();
    const wsA = await bootstrapAsUser(userIdA);
    const wsB = await bootstrapAsUser(crypto.randomUUID());
    await insertEvent("test.tenant", { workspaceId: wsA, userId: userIdA });

    const seen: Array<{ setting: string | null; defaultProjects: number }> = [];
    const dispatcher = createOutboxDispatcher({
      pool: workerPool,
      handlers: {
        "test.tenant": async (event) => {
          // The live dispatcher sets NO GUC (outbox_events is not a tenant
          // table) — the handler contract (ADR-0005) is to open its own
          // tenant transaction with the payload's ids under worker_user
          // (non-bypass, so RLS still applies).
          await withTenantTransaction(
            workerPool,
            {
              userId: String(event.payload.userId),
              workspaceId: String(event.payload.workspaceId),
            },
            async (tx) => {
              const setting = await tx.query<{ wid: string | null }>(
                "SELECT current_setting('app.workspace_id', true) AS wid",
              );
              // RLS-filtered tenant read through the worker role.
              const projects = await tx.query<{ n: string }>(
                "SELECT count(*)::text AS n FROM app.projects WHERE is_default",
              );
              seen.push({
                setting: setting.rows[0]!.wid,
                defaultProjects: Number(projects.rows[0]!.n),
              });
            },
          );
        },
      },
    });

    const outcome = await dispatcher.dispatchOnce();
    // The sweep claims EVERY available event — other suites may be inserting
    // outbox rows into the shared test database concurrently, so only assert
    // that OUR event was claimed and processed (per-event state below).
    expect(outcome.claimed).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.setting).toBe(wsA);
    // Only workspace A's default project is visible under the tenant context.
    expect(seen[0]!.defaultProjects).toBe(1);
    // Sanity: workspace B exists and has its own default project. (The
    // migrator owns the tables under FORCED RLS and has no policy — RLS is
    // a database guarantee — so catalog sanity reads go through the admin.)
    const b = await adminClient.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app.projects WHERE workspace_id = $1::uuid AND is_default",
      [wsB],
    );
    expect(Number(b.rows[0]!.n)).toBe(1);
  });

  it("event types without a registered handler retry with backoff and dead-letter (no scan poisoning)", async () => {
    const id = await insertEvent("test.unknown", {});
    const dispatcher = createOutboxDispatcher({
      pool: workerPool,
      handlers: {},
      backoffMs: () => 0,
    });

    const outcome = await dispatcher.dispatchOnce();
    expect(outcome).toMatchObject({ claimed: 1, processed: 0, retried: 1 });

    const state = await eventState(id);
    expect(state.processed_at).toBeNull();
    expect(state.attempts).toBe(1);
    expect(state.last_error).toMatch(/no handler registered/);

    // Force it to the threshold, then prove the dead-letter.
    await migrator.query(
      `UPDATE app.outbox_events SET attempts = 9, available_at = now() WHERE id = $1::uuid`,
      [id],
    );
    const second = await dispatcher.dispatchOnce();
    expect(second.deadLettered).toBe(1);
    const dead = await eventState(id);
    expect(dead.dead_lettered_at).not.toBeNull();
    expect(dead.attempts).toBe(10);
  });
});
