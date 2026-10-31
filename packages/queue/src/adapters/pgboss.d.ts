import type { JobQueue } from "../port";
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
export declare class PgBossQueueStub implements JobQueue {
    registerHandler(): void;
    enqueue(): Promise<{
        id: string;
    }>;
    schedule(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=pgboss.d.ts.map