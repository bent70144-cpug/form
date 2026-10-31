/**
 * JobQueue port (spec section "Queue, outbox, and audit": "The `JobQueue`
 * port exposes enqueue, schedule, and worker registration. The pg-boss
 * adapter implements it now; BullMQ replaces it at beta without changing
 * domain code.").
 *
 * Ticket 01 delivers the port plus an in-memory adapter so the worker is
 * runnable (heartbeats) before pg-boss lands (tickets 02/05). The pg-boss
 * adapter is a stubbed interface: it must use a DIRECT Postgres connection,
 * never the pooled application connection.
 */

export interface JobPayload {
  readonly [key: string]: unknown;
}

export interface JobHandlerContext {
  readonly jobId: string;
  readonly name: string;
  readonly attempt: number;
}

export type JobHandler<P extends JobPayload = JobPayload> = (
  payload: P,
  context: JobHandlerContext,
) => Promise<void> | void;

export interface EnqueueOptions {
  /** Delay in milliseconds before the job becomes available. */
  readonly delayMs?: number;
}

export interface ScheduleOptions {
  /** Cron expression for recurring jobs (pg-boss syntax at integration). */
  readonly cron: string;
}

/**
 * The queue port. Domain code depends only on this interface — swapping the
 * adapter must not require touching domain code.
 */
export interface JobQueue {
  /** Register a handler for a named job. */
  registerHandler<P extends JobPayload>(
    name: string,
    handler: JobHandler<P>,
  ): void;

  /** Enqueue a one-off job. */
  enqueue<P extends JobPayload>(
    name: string,
    payload: P,
    options?: EnqueueOptions,
  ): Promise<{ id: string }>;

  /** Register a recurring schedule (no-op before pg-boss arrives). */
  schedule(name: string, options: ScheduleOptions, payload?: JobPayload): Promise<void>;

  /** Start processing (idempotent). */
  start(): Promise<void>;

  /** Stop processing and release resources (idempotent). */
  stop(): Promise<void>;

  /** Whether the queue has been started and not yet stopped. */
  isStarted(): boolean;
}
