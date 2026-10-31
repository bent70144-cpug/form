import type {
  EnqueueOptions,
  JobHandler,
  JobPayload,
  JobQueue,
  ScheduleOptions,
} from "../port";

/**
 * pg-boss adapter stub.
 *
 * Ticket 01 boundary only — the real adapter arrives with the alpha topology
 * spike / workspace bootstrap slice (tickets 02/05), where it:
 *   - connects with a DIRECT Postgres URL (WORKER_DATABASE_URL), never the
 *     pooled app URL (transaction-mode pooling breaks session-scoped features
 *     such as advisory locks);
 *   - uses the `pgboss` schema whose DDL is installed by the migrator, with
 *     pg-boss's own migration skipped (spike ticket 02 confirms the option);
 *   - receives DML-only grants for `worker_user`.
 */
export class PgBossQueueStub implements JobQueue {
  registerHandler<P extends JobPayload>(
    _name: string,
    _handler: JobHandler<P>,
  ): void {
    throw new Error(
      "PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).",
    );
  }

  async enqueue<P extends JobPayload>(
    _name: string,
    _payload: P,
    _options?: EnqueueOptions,
  ): Promise<{ id: string }> {
    throw new Error(
      "PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).",
    );
  }

  async schedule(
    _name: string,
    _options: ScheduleOptions,
    _payload?: JobPayload,
  ): Promise<void> {
    throw new Error(
      "PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).",
    );
  }

  async start(): Promise<void> {
    throw new Error(
      "PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).",
    );
  }

  async stop(): Promise<void> {
    throw new Error(
      "PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).",
    );
  }

  isStarted(): boolean {
    return false;
  }
}
