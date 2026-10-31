import { PgBoss } from "pg-boss";
import {
  createOutboxDispatcher,
  intervalCron,
  DEFAULT_DISPATCH_INTERVAL_MS,
  type OutboxDispatcher,
} from "./outbox/dispatcher";
import { defaultOutboxHandlers } from "./outbox/handlers";

export {
  DEFAULT_DISPATCH_INTERVAL_MS,
  DEFAULT_MAX_ATTEMPTS,
  intervalCron,
} from "./outbox/dispatcher";

/** Alias kept for the ticket-02 heartbeat tests/ADR references. */
export const heartbeatCron = intervalCron;

/**
 * Worker process (ticket 02 spike): owns the pg-boss heartbeat.
 *
 * Topology decisions recorded in docs/adr/0003-topology-spike.md:
 * - Connects with the DIRECT WORKER_DATABASE_URL (transaction-mode pooling
 *   breaks session-scoped features such as advisory locks — spec).
 * - pg-boss 12.38.0 skips its own migration with `migrate: false` and does not
 *   touch DDL with `createSchema: false`: the `pgboss` schema is installed by
 *   the migrator (production: a migration; local dev/test: the migrator-role
 *   bootstrap step below/`pnpm db:start` companion).
 * - The heartbeat is a recurring pg-boss schedule so the dispatch pattern
 *   (ticket 05) reuses exactly this mechanism. Interval: 30s in alpha — the
 *   chosen compromise between Neon suspend-awake churn and dispatch latency.
 */
export interface WorkerOptions {
  databaseUrl: string;
  /** Heartbeat cadence in milliseconds (default 30_000). */
  heartbeatIntervalMs?: number;
  /** Outbox dispatch cadence in milliseconds (default 30_000, ADR-0003). */
  outboxDispatchIntervalMs?: number;
  /** Test hook: receive every heartbeat log line. */
  onHeartbeat?: (line: Record<string, unknown>) => void;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Recurring schedule expression for a cadence in milliseconds (moved to
 * outbox/dispatcher.ts as `intervalCron`; re-exported above as
 * `heartbeatCron` — pg-boss 12 accepts cron expressions and RFC 5545
 * recurrence rules, both verified via previewSchedule in the spike).
 */

/** Installs the pg-boss schema DDL as the migrator (dev/test companion step; production = migration).
 *
 * Spike finding (PostgreSQL 17): `CREATE SCHEMA IF NOT EXISTS` still demands
 * CREATE on the DATABASE even when the schema already exists, so the install
 * MUST run with `createSchema: false` — the `pgboss` schema is pre-created and
 * migrator-owned by the admin bootstrap.
 */
export async function installPgBossSchema(migratorUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: "pgboss",
    createSchema: false, // schema pre-created by the admin bootstrap
  });
  await boss.start(); // runs pg-boss's migration as the migrator
  await boss.stop({ graceful: false, timeout: 1000 });
}

export async function startWorker(options: WorkerOptions) {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    schema: "pgboss",
    // pg-boss 12.38.0: the actual skip-migration option (there is no
    // `migrations: { skipMigration: true }` in v12 — that shape is from
    // pg-boss 9/10 docs). DDL stays with the migrator; the runtime role is
    // DML-only, so it MUST NOT run migrations.
    migrate: false,
    createSchema: false,
    // pg-boss 12.38 defaults: cronMonitorIntervalSeconds=30 (allowed 1..45),
    // cronWorkerIntervalSeconds=5. A schedule created after start() would not
    // produce its first job for up to 30s+5s — spike finding: the heartbeat
    // test (15s deadline) missed it. A 5s monitor bounds dispatch latency to
    // roughly interval + 10s without meaningful extra load on Neon.
    cronMonitorIntervalSeconds: 5,
    cronWorkerIntervalSeconds: 5,
  });

  boss.on("error", (error) => {
    process.stderr.write(
      JSON.stringify({ event: "worker.pgboss_error", message: String(error) }) + "\n",
    );
  });

  await boss.start();

  // pg-boss 12 requires the queue to exist before scheduling/working on it.
  if (!(await boss.getQueue("heartbeat"))) {
    await boss.createQueue("heartbeat");
  }

  await boss.work<{ sequence: number }>("heartbeat", async (jobs) => {
    for (const job of jobs) {
      const line = {
        event: "worker.heartbeat",
        jobId: job.id,
        at: new Date().toISOString(),
        intervalMs: heartbeatIntervalMs,
      };
      process.stdout.write(JSON.stringify(line) + "\n");
      options.onHeartbeat?.(line);
    }
  });

  await boss.schedule("heartbeat", heartbeatCron(heartbeatIntervalMs), {
    sequence: 0,
  });

  // Outbox dispatcher (ticket 05): a second pg-boss schedule on the same
  // direct connection drains app.outbox_events (claims with FOR UPDATE SKIP
  // LOCKED under worker_user, retries with backoff, dead-letters after 10
  // attempts). Default cadence 30 s per ADR-0003.
  const outboxDispatcher = await createOutboxDispatcher({
    boss,
    workerDatabaseUrl: options.databaseUrl,
    handlers: defaultOutboxHandlers(),
    dispatchIntervalMs: options.outboxDispatchIntervalMs,
    logger: {
      info: (obj: Record<string, unknown>, msg: string) => process.stdout.write(JSON.stringify({ ...obj, msg }) + "\n"),
      warn: (obj: Record<string, unknown>, msg: string) => process.stderr.write(JSON.stringify({ ...obj, msg }) + "\n"),
    },
  });
  await outboxDispatcher.start();

  process.stdout.write(
    JSON.stringify({
      event: "worker.started",
      heartbeatIntervalMs,
      cron: heartbeatCron(heartbeatIntervalMs),
      outboxCron: intervalCron(
        options.outboxDispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS,
      ),
    }) + "\n",
  );

  return {
    async stop() {
      await outboxDispatcher.stop();
      await boss.offWork("heartbeat");
      await boss.stop({ graceful: false, timeout: 2000 });
    },
  };
}

const isMain = process.argv[1]?.endsWith("src/index.ts");
if (isMain) {
  const databaseUrl = process.env.WORKER_DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("[worker] WORKER_DATABASE_URL is required\n");
    process.exit(1);
  }
  const heartbeatIntervalMs = process.env.HEARTBEAT_INTERVAL_MS
    ? Number(process.env.HEARTBEAT_INTERVAL_MS)
    : undefined;

  let stopping = false;
  void (async () => {
    const worker = await startWorker({ databaseUrl, heartbeatIntervalMs });
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await worker.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  })();
}
