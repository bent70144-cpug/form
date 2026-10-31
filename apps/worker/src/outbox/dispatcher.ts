import type { PgBoss } from "pg-boss";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { isUuid, markTenantTransactionClient } from "@form/database";

/**
 * Transactional-outbox dispatcher (ticket 05, spec "Queue, outbox, and
 * audit").
 *
 * A pg-boss scheduled job (30 s cadence per ADR-0003 — the documented alpha
 * trade-off: bounded dispatch latency over Neon suspend savings) drains
 * `app.outbox_events`. Per event:
 *
 *   1. CLAIM — inside a transaction, `SELECT ... FOR UPDATE SKIP LOCKED`:
 *      concurrent dispatchers (or a restarted worker racing an in-flight
 *      one) can never claim the same row. The lock is HELD while the handler
 *      runs, so an event is processed by exactly one dispatcher at a time.
 *   2. RUN — attempts++ and dispatched_at are written in the claim
 *      transaction; handlers receive the transaction client so tenant work
 *      shares the event's transaction with `app.workspace_id` set from the
 *      PAYLOAD (the outbox has no workspace_id column) under the non-bypass
 *      `worker_user` role.
 *   3. MARK — processed_at commits atomically with the handler's writes: a
 *      crash mid-dispatch rolls BOTH back, so a restarted worker re-processes
 *      (never skips, never double-commits). Handlers must therefore be
 *      idempotent (spec) — `workspace.created` is a no-op.
 *   4. FAIL — the claim transaction ROLLS BACK; the failure accounting
 *      (attempts, last_error, backoff `available_at`) persists in a separate
 *      autocommit statement, so attempts still grow across restarts. After
 *      `maxAttempts` (default 10) the event is dead-lettered.
 */

export const OUTBOX_DISPATCH_QUEUE = "outbox-dispatch";

/** Default dispatch cadence: 30 s (ADR-0003; the 30-second cron). */
export const DEFAULT_DISPATCH_INTERVAL_MS = 30_000;

/** Dead-letter threshold (spec: "dead-letter state after 10 attempts"). */
export const DEFAULT_MAX_ATTEMPTS = 10;

export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Handler context: the dispatcher's claim transaction. Tenant queries go
 * through `query` — RLS applies because `app.workspace_id` was set from the
 * event payload for this transaction under `worker_user` (never a privileged
 * connection, spec).
 */
export interface OutboxHandlerContext {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  /** Workspace id carried in the payload (`workspaceId`), if any. */
  workspaceId: string | null;
}

export type OutboxHandler = (
  event: OutboxEvent,
  ctx: OutboxHandlerContext,
) => Promise<void> | void;

export interface DispatchOptions {
  pool: Pool;
  handlers: Record<string, OutboxHandler>;
  logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
  maxAttempts?: number;
  /** Backoff before the next attempt, from the attempt number (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Max events processed per dispatchOnce sweep. */
  sweepLimit?: number;
}

/** Exponential backoff: 1s, 2s, 4s, … capped at 60s. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export type DispatchOutcome =
  | { status: "empty" }
  | { status: "processed"; id: string; eventType: string }
  | { status: "retry"; id: string; attempt: number; delayMs: number }
  | { status: "dead_lettered"; id: string; attempts: number };

/**
 * Claims and processes ONE outbox event (or reports the queue as empty).
 * Exported for tests: the pg-boss job below simply sweeps this in a loop.
 */
export async function dispatchOne(options: DispatchOptions): Promise<DispatchOutcome> {
  const {
    pool,
    handlers,
    logger = silentLogger,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = defaultBackoffMs,
  } = options;

  const client = await pool.connect();
  try {
    // The claim transaction IS the tenant transaction for the handler's
    // queries: mark the client so the pool's tenant-query guard allows the
    // handler's RLS-scoped statements inside it.
    markTenantTransactionClient(client);
    await client.query("BEGIN");

    // CLAIM: skip rows locked by concurrent dispatchers / in-flight restarts.
    const claimed = await client.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `SELECT id::text, event_type, payload, attempts
         FROM app.outbox_events
        WHERE processed_at IS NULL
          AND dead_lettered_at IS NULL
          AND available_at <= now()
        ORDER BY available_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const row = claimed.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return { status: "empty" };
    }

    const attempts = Number(row.attempts) + 1;
    await client.query(
      "UPDATE app.outbox_events SET attempts = $2, dispatched_at = now() WHERE id = $1::uuid",
      [row.id, attempts],
    );

    // Tenant context FROM THE PAYLOAD (spec) — the outbox has no workspace_id
    // column. An invalid/absent id leaves the setting empty: nullif in the
    // policies turns that into NULL → zero rows, never a cast error.
    const rawWorkspaceId = row.payload?.workspaceId;
    const workspaceId =
      typeof rawWorkspaceId === "string" && isUuid(rawWorkspaceId)
        ? rawWorkspaceId
        : null;
    await client.query(
      "SELECT set_config('app.workspace_id', $1, true)",
      [workspaceId ?? ""],
    );

    const event: OutboxEvent = {
      id: row.id,
      eventType: row.event_type,
      payload: row.payload,
      attempts,
    };
    const handler = handlers[row.event_type];

    try {
      if (handler) {
        await handler(event, {
          query: (text, values) => client.query(text, values),
          workspaceId,
        });
      } else {
        // Unknown event type: tolerate and mark processed (registered
        // handlers are the mechanism; an unhandled type is a defect worth a
        // warning, not a 10-attempt retry storm).
        logger.warn({ eventId: event.id, eventType: event.eventType }, "outbox.no_handler");
      }
    } catch (error) {
      // RUN failed → the whole claim transaction (handler writes included)
      // rolls back; failure accounting persists outside it below.
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = backoffMs(attempts);
      if (attempts >= maxAttempts) {
        await pool.query(
          `UPDATE app.outbox_events
              SET attempts = attempts + 1,
                  last_error = $2,
                  dead_lettered_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE dead_lettered_at END
            WHERE id = $1::uuid`,
          [row.id, message, maxAttempts],
        );
        logger.warn({ eventId: row.id, eventType: row.event_type, attempts }, "outbox.dead_lettered");
        return { status: "dead_lettered", id: row.id, attempts };
      }
      await pool.query(
        `UPDATE app.outbox_events
            SET attempts = attempts + 1,
                last_error = $2,
                available_at = now() + make_interval(secs => $3::int)
          WHERE id = $1::uuid`,
        [row.id, message, Math.ceil(delayMs / 1000)],
      );
      logger.info({ eventId: row.id, eventType: row.event_type, attempts, delayMs }, "outbox.retry");
      return { status: "retry", id: row.id, attempt: attempts, delayMs };
    }

    // MARK processed atomically with the handler's committed writes.
    await client.query(
      "UPDATE app.outbox_events SET processed_at = now() WHERE id = $1::uuid",
      [row.id],
    );
    await client.query("COMMIT");
    logger.info({ eventId: row.id, eventType: row.event_type, attempts }, "outbox.processed");
    return { status: "processed", id: row.id, eventType: row.event_type };
  } finally {
    client.release();
  }
}

/** Drains up to `sweepLimit` events; returns the outcomes. */
export async function dispatchSweep(options: DispatchOptions): Promise<DispatchOutcome[]> {
  const limit = options.sweepLimit ?? 50;
  const outcomes: DispatchOutcome[] = [];
  for (let i = 0; i < limit; i++) {
    const outcome = await dispatchOne(options);
    if (outcome.status === "empty") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

export interface OutboxDispatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Manual sweep (tests + operational tooling). */
  dispatchOnce(): Promise<DispatchOutcome[]>;
}

export interface CreateOutboxDispatcherOptions extends Omit<DispatchOptions, "pool"> {
  boss: PgBoss;
  /** Direct worker URL (WORKER_DATABASE_URL) — never the pooled app URL. */
  workerDatabaseUrl: string;
  dispatchIntervalMs?: number;
}

/**
 * Wires the dispatcher into pg-boss: a recurring schedule (interval from
 * ADR-0003, 30 s default) whose job drains the outbox. The pg-boss job itself
 * always "succeeds" — retries/dead-lettering are tracked on the outbox row,
 * which survives worker restarts.
 */
export async function createOutboxDispatcher(
  options: CreateOutboxDispatcherOptions,
): Promise<OutboxDispatcher> {
  const {
    boss,
    workerDatabaseUrl,
    dispatchIntervalMs = DEFAULT_DISPATCH_INTERVAL_MS,
    ...dispatch
  } = options;
  const { createPool } = await import("@form/database");
  const pool = createPool(workerDatabaseUrl, { max: 2 });

  const sweep = () => dispatchSweep({ ...dispatch, pool });

  const cron = intervalCron(dispatchIntervalMs);

  return {
    async start() {
      // pg-boss 12 requires the queue to exist before scheduling/working it.
      if (!(await boss.getQueue(OUTBOX_DISPATCH_QUEUE))) {
        await boss.createQueue(OUTBOX_DISPATCH_QUEUE);
      }
      await boss.work(OUTBOX_DISPATCH_QUEUE, async (jobs) => {
        // Each scheduled job drains the whole outbox (the job is the tick;
        // per-job payloads carry no data).
        void jobs;
        await sweep();
      });
      await boss.schedule(OUTBOX_DISPATCH_QUEUE, cron);
      options.logger?.info({ cron, dispatchIntervalMs }, "outbox.dispatcher_started");
    },
    async stop() {
      await boss.offWork(OUTBOX_DISPATCH_QUEUE).catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
    dispatchOnce: sweep,
  };
}

/** Cron for a divisor of 60 s; RFC 5545 recurrence otherwise (ADR-0003). */
export function intervalCron(intervalMs: number): string {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  if (60 % seconds === 0) {
    return `*/${seconds} * * * * *`;
  }
  return `FREQ=SECONDLY;INTERVAL=${seconds}`;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};
