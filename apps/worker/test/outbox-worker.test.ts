import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPool, uuidv7 } from "@form/database";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  type BootstrappedUrls,
} from "@form/database/testing";
import {
  DEFAULT_DISPATCH_INTERVAL_MS,
  installPgBossSchema,
  OUTBOX_DISPATCH_JOB,
  startWorker,
} from "../src/index";

/**
 * Ticket 05 dispatcher slice — worker end-to-end against real Postgres:
 * the scheduled outbox-dispatch job claims `workspace.created` events
 * (inserted by app_user WITHOUT RETURNING) and the default handler logs the
 * structured event. Heartbeat stays wired through the same pg-boss instance
 * (ticket 02, covered in heartbeat.test.ts).
 */

const SCRATCH_DB = "t05_worker_outbox";

let urls: BootstrappedUrls;
let adminClient: Client;
let appPool: ReturnType<typeof createPool>;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

beforeAll(async () => {
  await createScratchDatabase(SCRATCH_DB);
  urls = await ensureBootstrapped(SCRATCH_DB);
  adminClient = new Client({ connectionString: urls.adminUrl });
  await adminClient.connect();

  // pgboss DDL as the migrator + DML-only runtime grants (worker_user).
  await installPgBossSchema(testRoleUrl("migrator", SCRATCH_DB));
  for (const sql of [
    `GRANT USAGE ON SCHEMA pgboss TO worker_user`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO worker_user`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO worker_user`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO worker_user`,
  ]) {
    await adminClient.query(sql);
  }

  appPool = createPool(urls.appUserUrl, { max: 2 });
}, 120_000);

afterAll(async () => {
  await adminClient?.end();
  await appPool?.end().catch(() => undefined);
  await dropDatabase(SCRATCH_DB);
});

async function insertWorkspaceCreated(payload: {
  workspaceId: string;
  userId: string;
}): Promise<string> {
  const id = uuidv7();
  // INSERT-only for app_user — no RETURNING (no SELECT grant).
  await appPool.query(
    `INSERT INTO app.outbox_events (id, event_type, payload)
     VALUES ($1, 'workspace.created', $2::jsonb)`,
    [id, JSON.stringify(payload)],
  );
  return id;
}

describe("worker: outbox dispatcher slice", () => {
  it("defaults the dispatch cadence to 30s (T02 Neon strategy)", () => {
    expect(DEFAULT_DISPATCH_INTERVAL_MS).toBe(30_000);
  });

  it("processes a workspace.created event end-to-end and logs the structured handler event", async () => {
    const id = await insertWorkspaceCreated({
      workspaceId: uuidv7(),
      userId: uuidv7(),
    });

    const logLines: Array<Record<string, unknown>> = [];
    const worker = await startWorker({
      databaseUrl: urls.workerUrl,
      heartbeatIntervalMs: 30_000, // not asserted here (heartbeat.test.ts)
      dispatchIntervalMs: 1_000, // fast cadence for the test window
      logger: {
        ...silentLogger,
        info: (line) => logLines.push(line),
      },
    });

    try {
      const deadline = Date.now() + 20_000;
      let processed = false;
      while (Date.now() < deadline && !processed) {
        const res = await adminClient.query<{ processed_at: string | null }>(
          "SELECT processed_at FROM app.outbox_events WHERE id = $1",
          [id],
        );
        processed = res.rows[0]?.processed_at != null;
        if (!processed) await new Promise((r) => setTimeout(r, 200));
      }
      expect(processed).toBe(true);

      const handlerLine = logLines.find(
        (line) => line["event"] === "outbox.workspace_created",
      );
      expect(handlerLine).toBeDefined();
      expect(handlerLine!["outboxEventId"]).toBe(id);
      expect(handlerLine!["workspaceId"]).toBeTypeOf("string");
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("retriggered dispatch ticks process the event exactly once (no reprocess)", async () => {
    const id = await insertWorkspaceCreated({
      workspaceId: uuidv7(),
      userId: uuidv7(),
    });

    const handlerCalls: string[] = [];
    const worker = await startWorker({
      databaseUrl: urls.workerUrl,
      dispatchIntervalMs: 30_000, // schedule stays the slow safety net
      outboxHandlers: {
        "workspace.created": (event) => void handlerCalls.push(event.id),
      },
      logger: silentLogger,
    });

    try {
      // pg-boss 12.38 throttles cron schedules to one job per 60s slot, so a
      // fast deterministic test drives extra ticks through the documented
      // low-latency path: enqueueing the dispatch job directly (ADR 0005).
      // The singleton queue policy keeps overlapping ticks from stacking.
      await worker.queue.enqueue(OUTBOX_DISPATCH_JOB, {});
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && handlerCalls.length === 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(handlerCalls).toEqual([id]);

      // A later tick must NOT rehandle the processed event.
      await worker.queue.enqueue(OUTBOX_DISPATCH_JOB, {});
      await new Promise((r) => setTimeout(r, 2_500));
      expect(handlerCalls).toEqual([id]);
    } finally {
      await worker.stop();
    }
  }, 25_000);
});
