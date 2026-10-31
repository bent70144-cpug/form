import { Client } from "pg";
import { createPool, uuidv7 } from "@form/database";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  type BootstrappedUrls,
} from "@form/database/testing";
import { grantPgBossRuntimeRole, installPgBossSchema } from "../src/index";
import type { Pool } from "pg";

/**
 * Shared setup for the queue suites: REAL roles over the embedded Postgres —
 * app_user inserts outbox events (INSERT-only, no RETURNING), worker_user
 * runs the dispatcher. The `pgboss` schema is installed by the MIGRATOR and
 * the runtime role receives DML-only grants (never migrates).
 */

export const SCRATCH_DB = "t05_outbox_queue";

export interface QueueTestContext {
  urls: BootstrappedUrls;
  /** Deletes all outbox rows + test effects (admin) for test isolation. */
  clearOutbox(): Promise<void>;
  /** app_user pool (request role: INSERT-only on outbox_events). */
  appPool: Pool;
  /** worker_user pool, tenantGuard disabled (outbox is not a tenant table). */
  workerPool: Pool;
  /** Admin (superuser) client for catalog inspection + effect-table setup. */
  admin: Client;
  insertEvent(
    eventType: string,
    payload: Record<string, unknown>,
    options?: { availableAtSql?: string },
  ): Promise<string>;
}

export async function setupQueueTest(
  dbName: string = SCRATCH_DB,
): Promise<QueueTestContext> {
  await createScratchDatabase(dbName);
  const urls = await ensureBootstrapped(dbName);

  // pgboss DDL as the migrator; runtime role stays DML-only.
  await installPgBossSchema(testRoleUrl("migrator", dbName));
  await grantPgBossRuntimeRole(urls.adminUrl);

  const admin = new Client({ connectionString: urls.adminUrl });
  await admin.connect();

  // Effect table for handler-contract tests (migrator-owned, worker DML).
  await admin.query(`
    CREATE TABLE IF NOT EXISTS app.outbox_test_effects (
      event_id uuid PRIMARY KEY,
      note     text
    )
  `);
  await admin.query(
    `GRANT INSERT, SELECT, UPDATE ON app.outbox_test_effects TO worker_user`,
  );

  const appPool = createPool(urls.appUserUrl, { max: 5 });
  const workerPool = createPool(urls.workerUrl, {
    max: 5,
    // outbox_events is NOT in TENANT_TABLES (verified): the guard exists for
    // tenant tables only and the dispatcher owns raw non-tenant SQL; handlers
    // needing tenant data open their own withTenantTransaction.
    tenantGuard: false,
  });

  // Idle pool clients can emit 'error' (e.g. the restart-safety test
  // deliberately terminates a backend). Without a listener, node turns that
  // into an uncaught exception; the suites handle query errors themselves.
  // The client-level listener guarantees every pool client has one (pg-pool's
  // own idle listener is removed after the first error).
  for (const pool of [appPool, workerPool]) {
    pool.on("error", () => undefined);
    pool.on("connect", (client) => {
      client.on("error", () => undefined);
    });
  }

  /** Wipes outbox rows (admin) so tests asserting exact counts stay isolated. */
  async function clearOutbox(): Promise<void> {
    await admin.query("DELETE FROM app.outbox_events");
    await admin.query("DELETE FROM app.outbox_test_effects");
  }

  async function insertEvent(
    eventType: string,
    payload: Record<string, unknown>,
    options?: { availableAtSql?: string },
  ): Promise<string> {
    const id = uuidv7();
    // INSERT WITHOUT RETURNING — app_user has no SELECT grant on
    // outbox_events, so RETURNING would fail (migration 0003 contract).
    await appPool.query(
      `INSERT INTO app.outbox_events (id, event_type, payload, available_at)
       VALUES ($1, $2, $3::jsonb, ${options?.availableAtSql ?? "now()"})`,
      [id, eventType, JSON.stringify(payload)],
    );
    return id;
  }

  return { urls, appPool, workerPool, admin, clearOutbox, insertEvent };
}

export async function teardownQueueTest(
  ctx: QueueTestContext | null,
  dbName: string = SCRATCH_DB,
): Promise<void> {
  if (!ctx) return;
  await ctx.appPool.end().catch(() => undefined);
  await ctx.workerPool.end().catch(() => undefined);
  await ctx.admin.end().catch(() => undefined);
  await dropDatabase(dbName);
}

export async function fetchEventRow(
  pool: Pool,
  id: string,
): Promise<{
  id: string;
  attempts: number;
  processed_at: string | null;
  dispatched_at: string | null;
  dead_lettered_at: string | null;
  available_at: string;
  last_error: string | null;
} | null> {
  const res = await pool.query(
    `SELECT id, attempts, processed_at, dispatched_at, dead_lettered_at,
            available_at, last_error
       FROM app.outbox_events WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}
