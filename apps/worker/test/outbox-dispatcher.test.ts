import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { createPool, withUserTransaction } from "@form/database";
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
  dispatchOne,
  intervalCron,
  type DispatchOptions,
} from "../src/outbox/dispatcher";
import { defaultOutboxHandlers } from "../src/outbox/handlers";
import { installPgBossSchema } from "../src/index";

/**
 * Ticket 05 — outbox dispatcher against real Postgres, running under the
 * real `worker_user` role (SELECT/UPDATE on outbox_events only):
 *
 *   - processes `workspace.created` produced by a REAL bootstrap and marks it
 *     processed exactly once (a second sweep is a no-op — no double-process);
 *   - a failed handler (crash simulation) leaves the event unprocessed with
 *     failure accounting; a RESTARTED dispatcher (fresh call) completes it
 *     exactly once more;
 *   - dead-letters after the attempt limit (override proves the mechanism;
 *     the exported default pins the spec's 10 attempts);
 *   - handlers touching tenant tables see `app.workspace_id` set from the
 *     payload under worker_user (RLS-filtered tenant read);
 *   - the pg-boss schedule fires the dispatch without manual sweeps.
 */

const SCRATCH_DB = "t05_outbox";

let urls: BootstrappedUrls;
let adminClient: Client;
let migrator: Client;
let workerPoolUrl: string;

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

/** Worker-role pool for the dispatcher (direct URL, tenant-guard armed). */
function openWorkerPool(): Pool {
  return createPool(workerPoolUrl, { max: 2 });
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

type Handler = NonNullable<DispatchOptions["handlers"]>[string];

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
}, 120_000);

afterAll(async () => {
  await migrator?.end();
  await adminClient?.end();
  await dropDatabase(SCRATCH_DB);
});

describe("dispatchOne under worker_user", () => {
  it("processes a real workspace.created event exactly once (no double-process on re-sweep)", async () => {
    // REAL producer: bootstrap as app_user via the security-definer function.
    const workspaceId = await bootstrapAsUser(crypto.randomUUID());

    const handlerCalls: string[] = [];
    const handlers: Record<string, Handler> = {
      "workspace.created": async (event) => {
        handlerCalls.push(event.payload.workspaceId as string);
      },
    };
    const pool = openWorkerPool();
    try {
      const outcome = await dispatchOne({ pool, handlers });
      expect(outcome).toMatchObject({
        status: "processed",
        eventType: "workspace.created",
      });

      const state = await eventState((outcome as { id: string }).id);
      expect(state.processed_at).not.toBeNull();
      expect(state.attempts).toBe(1);
      expect(state.dead_lettered_at).toBeNull();
      expect(handlerCalls).toEqual([workspaceId]);

      // Re-sweep: already-processed rows are never claimed again.
      const again = await dispatchOne({ pool, handlers });
      expect(again.status).toBe("empty");
      expect(handlerCalls).toEqual([workspaceId]);
      const state2 = await eventState((outcome as { id: string }).id);
      expect(state2.attempts).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("crash simulation: a failed handler leaves the event unprocessed; a RESTARTED dispatcher finishes it exactly once", async () => {
    const id = await insertEvent("test.crash", { n: 1 });
    const successCalls: number[] = [];

    const failing: Record<string, Handler> = {
      "test.crash": async () => {
        throw new Error("injected crash mid-dispatch");
      },
    };
    const succeeding: Record<string, Handler> = {
      "test.crash": async () => {
        successCalls.push(1);
      },
    };

    const pool = openWorkerPool();
    try {
      // First dispatcher instance (about to "crash").
      const first = await dispatchOne({
        pool,
        handlers: failing,
        backoffMs: () => 0,
      });
      expect(first).toMatchObject({ status: "retry", attempt: 1 });
      let state = await eventState(id);
      expect(state.processed_at).toBeNull();
      expect(state.attempts).toBe(1);
      expect(state.last_error).toContain("injected crash");

      // RESTART: a fresh dispatcher call picks it up and finishes it.
      const second = await dispatchOne({
        pool,
        handlers: succeeding,
        backoffMs: () => 0,
      });
      expect(second).toMatchObject({ status: "processed" });
      state = await eventState(id);
      expect(state.processed_at).not.toBeNull();
      expect(state.attempts).toBe(2);
      // Exactly-once completion: the successful handler ran once.
      expect(successCalls).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("dead-letters after the attempt limit (spec default: 10 attempts)", async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(10);
    const id = await insertEvent("test.dead", {});
    const pool = openWorkerPool();
    try {
      const options = {
        pool,
        handlers: {
          "test.dead": async () => {
            throw new Error("always fails");
          },
        } satisfies Record<string, Handler>,
        backoffMs: () => 0,
        maxAttempts: 3, // mechanism-level override; the default is pinned above
      };
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const outcome = await dispatchOne(options);
        outcomes.push(outcome.status);
      }
      expect(outcomes).toEqual(["retry", "retry", "dead_lettered"]);
      const state = await eventState(id);
      expect(state.dead_lettered_at).not.toBeNull();
      expect(state.attempts).toBe(3);
      expect(state.processed_at).toBeNull();

      // Dead-lettered rows are never claimed again.
      const after = await dispatchOne(options);
      expect(after.status).toBe("empty");
    } finally {
      await pool.end();
    }
  });

  it("handlers touching tenant tables see app.workspace_id from the payload under worker_user", async () => {
    // Two REAL workspaces: the handler must only see the payload's one.
    const wsA = await bootstrapAsUser(crypto.randomUUID());
    const wsB = await bootstrapAsUser(crypto.randomUUID());
    await insertEvent("test.tenant", { workspaceId: wsA });

    const seen: Array<{ setting: string | null; defaultProjects: number }> = [];
    const pool = openWorkerPool();
    try {
      const outcome = await dispatchOne({
        pool,
        handlers: {
          "test.tenant": async (event, ctx) => {
            const setting = await ctx.query<{ wid: string | null }>(
              "SELECT current_setting('app.workspace_id', true) AS wid",
            );
            // RLS-filtered tenant read through the worker role.
            const projects = await ctx.query<{ n: string }>(
              "SELECT count(*)::text AS n FROM app.projects WHERE is_default",
            );
            seen.push({
              setting: setting.rows[0]!.wid,
              defaultProjects: Number(projects.rows[0]!.n),
            });
            if (event.payload.workspaceId !== seen[0]!.setting) {
              throw new Error("payload workspace mismatch");
            }
          },
        },
      });
      expect(outcome).toMatchObject({ status: "processed" });
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
    } finally {
      await pool.end();
    }
  });

  it("marks unknown event types processed with a warning (no retry storm)", async () => {
    const id = await insertEvent("test.unknown", {});
    const pool = openWorkerPool();
    try {
      const outcome = await dispatchOne({ pool, handlers: {} });
      expect(outcome).toMatchObject({
        status: "processed",
        eventType: "test.unknown",
      });
      const state = await eventState(id);
      expect(state.processed_at).not.toBeNull();
      expect(state.attempts).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe("pg-boss scheduled dispatch", () => {
  it("schedule expression matches the ADR-0003 30s cadence", () => {
    expect(intervalCron(30_000)).toBe("*/30 * * * * *");
  });

  it("a scheduled dispatcher drains the outbox without manual sweeps", async () => {
    const boss = new PgBoss({
      connectionString: workerPoolUrl,
      schema: "pgboss",
      migrate: false,
      createSchema: false,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
    });
    await boss.start();
    const dispatcher = await createOutboxDispatcher({
      boss,
      workerDatabaseUrl: workerPoolUrl,
      handlers: defaultOutboxHandlers(),
      dispatchIntervalMs: 1000, // test cadence; production default is 30s
    });
    try {
      await dispatcher.start();
      const workspaceId = await bootstrapAsUser(crypto.randomUUID());

      // The scheduled job should process the real workspace.created event.
      const deadline = Date.now() + 20_000;
      let processed = false;
      while (Date.now() < deadline && !processed) {
        const res = await migrator.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM app.outbox_events
            WHERE event_type = 'workspace.created'
              AND (payload->>'workspaceId')::uuid = $1::uuid
              AND processed_at IS NOT NULL`,
          [workspaceId],
        );
        processed = Number(res.rows[0]!.n) === 1;
        if (!processed) await new Promise((r) => setTimeout(r, 250));
      }
      expect(processed).toBe(true);
    } finally {
      await dispatcher.stop();
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    }
  }, 30_000);
});
