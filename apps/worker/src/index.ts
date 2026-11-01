import pino from "pino";
import { loadEnv, workerEnvSchema, type WorkerEnv } from "@form/config";
import { createPool } from "@form/database";
import {
  PgBossJobQueue,
  createOutboxDispatcher,
  installPgBossSchema,
  type JobQueue,
  type OutboxDispatcher,
  type OutboxHandler,
  type OutboxLogger,
} from "@form/queue";
import {
  WORKSPACE_CREATED_EVENT,
  createWorkspaceCreatedHandler,
} from "./handlers/workspace-created";
import {
  FORM_CREATED_EVENT,
  createFormCreatedHandler,
} from "./handlers/form-created";

export { installPgBossSchema };

/**
 * Worker process (ticket 02 spike + ticket 05 dispatcher slice).
 *
 * Topology decisions recorded in docs/adr/0003-topology-spike.md and
 * docs/adr/0005-outbox-dispatcher.md:
 * - Connects with the DIRECT WORKER_DATABASE_URL (transaction-mode pooling
 *   breaks session-scoped features such as advisory locks — spec). The
 *   pg-boss adapter AND the outbox dispatcher both use it.
 * - pg-boss 12.38.0 skips its own migration with `migrate: false` and does
 *   not touch DDL with `createSchema: false`: the `pgboss` schema is
 *   installed by the migrator (production: a migration; local dev/test: the
 *   migrator-role bootstrap step — `installPgBossSchema`).
 * - The heartbeat is a recurring pg-boss schedule (ticket 02) and the outbox
 *   dispatch reuses exactly this mechanism (ticket 05): both tick at
 *   HEARTBEAT_INTERVAL_MS (default 30s) — the chosen compromise between Neon
 *   suspend-awake churn and dispatch latency.
 * - Both queues are created with the `singleton` policy so a slow tick never
 *   stacks with the next one.
 *
 * Runtime environment: WORKER_DATABASE_URL (+ LOG_LEVEL,
 * HEARTBEAT_INTERVAL_MS), Zod-validated at startup via workerEnvSchema —
 * an invalid/missing variable aborts the process before any work.
 */

export interface WorkerOptions {
  databaseUrl: string;
  /** Heartbeat cadence in milliseconds (default 30_000).
   *  The `main` entrypoint wires this to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  /** Outbox dispatch cadence in milliseconds (default 30_000).
   *  The `main` entrypoint wires this to HEARTBEAT_INTERVAL_MS too — the
   *  single env source of truth for both cadences (ADR-0003/0005). */
  dispatchIntervalMs?: number;
  /** Log level (default "info"; the main entrypoint passes the validated
   *  LOG_LEVEL env value). */
  logLevel?: string;
  /** Structured logger (default: pino on stdout). */
  logger?: OutboxLogger;
  /** Outbox handlers keyed by event_type (default: workspace.created +
   *  form.created loggers). */
  outboxHandlers?: Record<string, OutboxHandler>;
  /** Test hook: receive every heartbeat log line. */
  onHeartbeat?: (line: Record<string, unknown>) => void;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_DISPATCH_INTERVAL_MS = 30_000;
export const HEARTBEAT_JOB = "heartbeat";
export const OUTBOX_DISPATCH_JOB = "outbox.dispatch";

/**
 * Recurring schedule expression for a cadence in milliseconds. pg-boss 12
 * accepts cron expressions and RFC 5545 recurrence rules: 6-field cron with a
 * seconds field works for divisors of 60s; anything else uses RRULE
 * FREQ=SECONDLY (both verified via previewSchedule in the spike).
 */
export function heartbeatCron(intervalMs: number): string {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  if (60 % seconds === 0) {
    return `*/${seconds} * * * * *`;
  }
  return `FREQ=SECONDLY;INTERVAL=${seconds}`;
}

export interface StartedWorker {
  queue: JobQueue;
  dispatcher: OutboxDispatcher;
  stop(): Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<StartedWorker> {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const dispatchIntervalMs =
    options.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS;
  const logger: OutboxLogger =
    options.logger ??
    pino({
      // The main entrypoint validates the environment and passes LOG_LEVEL
      // through; programmatic callers (tests) pass logLevel or a logger.
      level: options.logLevel ?? "info",
    });

  // The dispatcher pool: worker_user over the DIRECT URL. tenantGuard is off
  // because outbox_events is not a tenant table (verified against
  // TENANT_TABLES) and dispatcher SQL is non-tenant; handlers that read
  // tenant tables open their own withTenantTransaction (worker_user is
  // non-bypass, so RLS still applies).
  const pool = createPool(options.databaseUrl, { max: 5, tenantGuard: false });
  // Idle pool clients can emit 'error' (e.g. a backend killed by an
  // administrator); without a listener node would crash the worker.
  pool.on("error", (error: Error) => {
    logger.error({ event: "worker.pool_error", message: String(error) });
  });

  const dispatcher = createOutboxDispatcher({
    pool,
    handlers: options.outboxHandlers ?? {
      [WORKSPACE_CREATED_EVENT]: createWorkspaceCreatedHandler(logger),
      [FORM_CREATED_EVENT]: createFormCreatedHandler(logger),
    },
    logger,
  });

  const queue = new PgBossJobQueue({
    connectionString: options.databaseUrl,
    defaultQueuePolicy: "singleton",
  });

  queue.registerHandler(HEARTBEAT_JOB, async (_payload, context) => {
    const line = {
      event: "worker.heartbeat",
      jobId: context.jobId,
      at: new Date().toISOString(),
      intervalMs: heartbeatIntervalMs,
    };
    logger.info(line, "worker heartbeat");
    options.onHeartbeat?.(line);
  });

  queue.registerHandler(OUTBOX_DISPATCH_JOB, async () => {
    await dispatcher.dispatchOnce();
  });

  await queue.start();

  await queue.schedule(
    HEARTBEAT_JOB,
    { cron: heartbeatCron(heartbeatIntervalMs) },
    { sequence: 0 },
  );
  await queue.schedule(OUTBOX_DISPATCH_JOB, {
    cron: heartbeatCron(dispatchIntervalMs),
  });

  process.stdout.write(
    JSON.stringify({
      event: "worker.started",
      heartbeatIntervalMs,
      heartbeatCron: heartbeatCron(heartbeatIntervalMs),
      dispatchIntervalMs,
      dispatchCron: heartbeatCron(dispatchIntervalMs),
    }) + "\n",
  );

  return {
    queue,
    dispatcher,
    async stop() {
      await queue.stop();
      await pool.end();
    },
  };
}

const isMain = process.argv[1]?.endsWith("src/index.ts");
if (isMain) {
  // Fail fast on an invalid environment (spec: Zod-validated, fails at
  // startup) — before ANY work, mirroring the api/web entrypoints.
  let env: WorkerEnv;
  try {
    env = loadEnv(workerEnvSchema);
  } catch (error) {
    process.stderr.write(
      `[worker] ${(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exit(1);
  }

  let stopping = false;
  void (async () => {
    const worker = await startWorker({
      databaseUrl: env.WORKER_DATABASE_URL,
      // HEARTBEAT_INTERVAL_MS drives BOTH cadences (ADR-0003/0005).
      heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
      dispatchIntervalMs: env.HEARTBEAT_INTERVAL_MS,
      logLevel: env.LOG_LEVEL,
    });
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
