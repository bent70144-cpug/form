import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  type BootstrappedUrls,
} from "@form/database/testing";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  heartbeatCron,
  installPgBossSchema,
  startWorker,
} from "../src/index";

/**
 * Ticket 02 spike — pg-boss heartbeat against real Postgres:
 * - the `pgboss` schema DDL is installed by the MIGRATOR (its own migration),
 * - the runtime worker connects as `worker_user` (DML only, no migration),
 * - a recurring heartbeat schedule fires and logs.
 */

const SCRATCH_DB = "t02_worker_spike";

let urls: BootstrappedUrls;
let adminClient: Client;

beforeAll(async () => {
  await createScratchDatabase(SCRATCH_DB);
  urls = await ensureBootstrapped(SCRATCH_DB);
  adminClient = new Client({ connectionString: urls.adminUrl });
  await adminClient.connect();

  // pg-boss DDL as the migrator (production: a migration owns this).
  await installPgBossSchema(testRoleUrl("migrator", SCRATCH_DB));

  // Runtime grants for worker_user: DML on pgboss tables, sequences, and
  // function execution — no CREATE, no schema ownership.
  for (const sql of [
    `GRANT USAGE ON SCHEMA pgboss TO worker_user`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO worker_user`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO worker_user`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO worker_user`,
  ]) {
    await adminClient.query(sql);
  }
}, 120_000);

afterAll(async () => {
  await adminClient?.end();
  await dropDatabase(SCRATCH_DB);
});

describe("pg-boss heartbeat (direct URL, worker_user, migration skipped)", () => {
  it("runs a scheduled heartbeat job and logs the heartbeat line", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const worker = await startWorker({
      databaseUrl: testRoleUrl("worker_user", SCRATCH_DB),
      heartbeatIntervalMs: 1000,
      onHeartbeat: (line) => lines.push(line),
    });
    try {
      // Wait for the first scheduled heartbeat (cron seconds cadence).
      const deadline = Date.now() + 15_000;
      while (lines.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toMatchObject({ event: "worker.heartbeat" });
      expect(typeof lines[0]!.jobId).toBe("string");
    } finally {
      await worker.stop();
    }
  }, 25_000);

  it("keeps the pgboss schema migrator-owned and worker_user DML-only", async () => {
    const owner = await adminClient.query<{ tableowner: string }>(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'pgboss' LIMIT 1`,
    );
    expect(["migrator", "postgres"]).toContain(owner.rows[0]!.tableowner);

    // worker_user cannot CREATE in pgboss (DDL stays with the migrator).
    const workerProbe = new Client({
      connectionString: testRoleUrl("worker_user", SCRATCH_DB),
    });
    await workerProbe.connect();
    try {
      await expect(
        workerProbe.query("CREATE TABLE pgboss.rogue (id int)"),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await workerProbe.end();
    }
  });

  it("picks a schedule expression that fires every 30s (Neon keep-awake choice)", async () => {
    expect(heartbeatCron(DEFAULT_HEARTBEAT_INTERVAL_MS)).toBe("*/30 * * * * *");
    expect(heartbeatCron(1000)).toBe("*/1 * * * * *");
    // Non-divisor intervals fall back to an RFC 5545 recurrence rule.
    expect(heartbeatCron(45_000)).toBe("FREQ=SECONDLY;INTERVAL=45");
  });
});
