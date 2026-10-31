import type { Pool, PoolClient } from "pg";

/**
 * Transactional outbox dispatcher (spec section "Queue, outbox, and audit"):
 *
 * "A pg-boss scheduled job dispatches available outbox rows to idempotent
 * handlers ... The dispatcher claims with `FOR UPDATE SKIP LOCKED`, retries
 * with backoff, and moves events to a dead-letter state after 10 attempts.
 * A worker restart mid-dispatch does not lose or double-process an in-flight
 * event."
 *
 * Claim algorithm (see docs/adr/0005-outbox-dispatcher.md):
 *   BEGIN
 *     SELECT ... FROM app.outbox_events
 *       WHERE available_at <= now() AND processed_at IS NULL
 *         AND dead_lettered_at IS NULL
 *       ORDER BY available_at, id
 *       FOR UPDATE SKIP LOCKED          -- concurrent dispatchers skip rows
 *     UPDATE ... SET dispatched_at = COALESCE(dispatched_at, now())  -- in-flight marker
 *     for each event: run the registered handler
 *       - success  → processed_at = now()
 *       - failure  → attempts+1, available_at = now() + backoff;
 *                    10th failure → dead_lettered_at = now()
 *   COMMIT
 *
 * The claim and the handler execution share ONE transaction: a crash
 * mid-handler rolls the claim back, so the event is never lost and is
 * redelivered on a later tick. Redelivery after a partially-applied side
 * effect is exactly why handlers are IDEMPOTENT (contract below).
 *
 * Handler idempotency contract:
 *   - Handlers may be invoked MORE THAN ONCE per event (crash between the
 *     handler's side effect and the claim COMMIT, or redelivery after a
 *     rollback). Handlers must key their effect on the event (prefer the
 *     event `id`) and no-op when the effect already exists (unique
 *     constraint + upsert, or a naturally replayable effect such as
 *     idempotent logging).
 *   - Handlers run while the event row is locked inside the dispatcher
 *     transaction; they must NOT assume the claim has committed yet.
 *   - outbox_events is NOT a tenant table (no RLS, no workspace_id column) —
 *     the dispatcher needs no `app.workspace_id` GUC. Later handlers that
 *     read tenant tables must open their own `withTenantTransaction`
 *     (worker_user is non-bypass) and set `app.workspace_id` from the event
 *     payload.
 */

/** Shape handed to registered handlers. */
export interface OutboxHandlerEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Attempts BEFORE this delivery (0 on first delivery). */
  readonly attempts: number;
}

export type OutboxHandler = (event: OutboxHandlerEvent) => Promise<void> | void;

/** Minimal structured-logger surface (pino-compatible subset). */
export interface OutboxLogger {
  info(line: Record<string, unknown>, message?: string): void;
  warn(line: Record<string, unknown>, message?: string): void;
  error(line: Record<string, unknown>, message?: string): void;
}

export interface OutboxDispatcherOptions {
  /**
   * worker_user pool over the DIRECT worker URL. Create it with
   * `createPool(url, { tenantGuard: false })`: `outbox_events` is not a
   * tenant table (packages/database/src/tenant-tables.ts), so the guard adds
   * nothing for dispatcher SQL, and handlers own their own tenant
   * transactions.
   */
  pool: Pool;
  /** Idempotent handlers keyed by `event_type`. */
  handlers: Record<string, OutboxHandler>;
  /** Rows claimed per tick (default 25). */
  batchSize?: number;
  /** Dead-letter threshold (default 10 — spec). */
  maxAttempts?: number;
  /**
   * Backoff before the next availability, in ms, after failed attempt N
   * (1-based). Default: exponential 1s·2^(N-1), capped at 10 minutes.
   */
  backoffMs?: (attempt: number) => number;
  logger?: OutboxLogger;
}

export interface DispatchOutcome {
  /** Rows claimed this tick (rows locked by a concurrent dispatcher are NOT included). */
  claimed: number;
  /** Rows marked processed. */
  processed: number;
  /** Rows scheduled for retry. */
  retried: number;
  /** Rows moved to the dead-letter state this tick. */
  deadLettered: number;
}

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_BATCH_SIZE = 25;
const MAX_BACKOFF_MS = 600_000;
const LAST_ERROR_MAX_CHARS = 2000;

/** Exponential backoff: 1s, 2s, 4s, … capped at 10 minutes. */
export function defaultBackoffMs(attempt: number): number {
  const raw = 1000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, MAX_BACKOFF_MS);
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > LAST_ERROR_MAX_CHARS
    ? `${message.slice(0, LAST_ERROR_MAX_CHARS)}…`
    : message;
}

function stdoutLogger(): OutboxLogger {
  const write = (
    level: string,
    line: Record<string, unknown>,
    message?: string,
  ): void => {
    process.stdout.write(
      JSON.stringify(message ? { level, message, ...line } : { level, ...line }) +
        "\n",
    );
  };
  return {
    info: (line, message) => write("info", line, message),
    warn: (line, message) => write("warn", line, message),
    error: (line, message) => write("error", line, message),
  };
}

export class OutboxDispatcher {
  private readonly pool: Pool;
  private readonly handlers: Record<string, OutboxHandler>;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly logger: OutboxLogger;

  constructor(options: OutboxDispatcherOptions) {
    this.pool = options.pool;
    this.handlers = options.handlers;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.logger = options.logger ?? stdoutLogger();
  }

  /**
   * One dispatcher tick: claim a batch and drive each event to either
   * `processed_at` or a retry/dead-letter update, atomically. Returns the
   * outcome counters; `claimed === 0` is the normal steady state.
   */
  async dispatchOnce(batchSize?: number): Promise<DispatchOutcome> {
    const limit = batchSize ?? this.batchSize;
    const client = await this.pool.connect();
    const outcome: DispatchOutcome = {
      claimed: 0,
      processed: 0,
      retried: 0,
      deadLettered: 0,
    };
    try {
      await client.query("BEGIN");
      // Claim: SKIP LOCKED lets concurrent dispatchers proceed with OTHER
      // rows instead of blocking or double-claiming.
      const claimed = await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        attempts: number;
      }>(
        `SELECT id, event_type, payload, attempts
           FROM app.outbox_events
          WHERE processed_at IS NULL
            AND dead_lettered_at IS NULL
            AND available_at <= now()
          ORDER BY available_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      outcome.claimed = claimed.rows.length;
      if (claimed.rows.length === 0) {
        await client.query("COMMIT");
        return outcome;
      }

      // In-flight marker (first-dispatch timestamp); rolled back on crash.
      await client.query(
        `UPDATE app.outbox_events
            SET dispatched_at = COALESCE(dispatched_at, now())
          WHERE id = ANY($1::uuid[])`,
        [claimed.rows.map((row) => row.id)],
      );

      for (const row of claimed.rows) {
        const event: OutboxHandlerEvent = {
          id: row.id,
          eventType: row.event_type,
          payload: row.payload,
          attempts: row.attempts,
        };
        const handler = this.handlers[row.event_type];
        if (!handler) {
          // Unknown event types must not poison the scan forever: record a
          // failure so they retry with backoff and eventually dead-letter.
          await this.recordFailure(client, event, outcome, new Error(
            `no handler registered for outbox event type "${row.event_type}"`,
          ));
          continue;
        }
        try {
          await handler(event);
          await client.query(
            `UPDATE app.outbox_events
                SET processed_at = now(),
                    last_error = NULL
              WHERE id = $1`,
            [row.id],
          );
          outcome.processed += 1;
        } catch (error) {
          await this.recordFailure(client, event, outcome, error);
        }
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Infrastructure failure (connection lost, deadlock): nothing is
      // committed — claims roll back and the next tick redelivers.
      this.logger.error({
        event: "outbox.dispatch_failed",
        message: truncateError(error),
      });
      throw error;
    } finally {
      client.release();
    }

    if (outcome.processed > 0) {
      this.logger.info({ event: "outbox.processed", count: outcome.processed });
    }
    if (outcome.retried > 0) {
      this.logger.warn({ event: "outbox.retried", count: outcome.retried });
    }
    if (outcome.deadLettered > 0) {
      this.logger.error({
        event: "outbox.dead_lettered",
        count: outcome.deadLettered,
      });
    }
    return outcome;
  }

  /** Failure bookkeeping inside the claim transaction (never throws). */
  private async recordFailure(
    client: PoolClient,
    event: OutboxHandlerEvent,
    outcome: DispatchOutcome,
    error: unknown,
  ): Promise<void> {
    const nextAttempt = event.attempts + 1;
    const deadLetter = nextAttempt >= this.maxAttempts;
    const backoffSeconds = Math.max(0, this.backoffMs(nextAttempt) / 1000);
    try {
      await client.query(
        `UPDATE app.outbox_events
            SET attempts = attempts + 1,
                last_error = $2,
                available_at = CASE WHEN $3 THEN available_at
                                    ELSE now() + make_interval(secs => $4) END,
                dead_lettered_at = CASE WHEN $3 THEN now()
                                        ELSE dead_lettered_at END
          WHERE id = $1`,
        [event.id, truncateError(error), deadLetter, backoffSeconds],
      );
      if (deadLetter) outcome.deadLettered += 1;
      else outcome.retried += 1;
    } catch (bookkeepingError) {
      // The failure UPDATE is part of the same transaction; if even it fails
      // the tick is unsalvageable — abort so the claim rolls back and the
      // event is simply redelivered later.
      throw bookkeepingError;
    }
  }
}

export function createOutboxDispatcher(
  options: OutboxDispatcherOptions,
): OutboxDispatcher {
  return new OutboxDispatcher(options);
}
