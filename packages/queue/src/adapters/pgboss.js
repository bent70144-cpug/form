"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PgBossQueueStub = void 0;
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
class PgBossQueueStub {
    registerHandler() {
        throw new Error("PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).");
    }
    async enqueue() {
        throw new Error("PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).");
    }
    async schedule() {
        throw new Error("PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).");
    }
    async start() {
        throw new Error("PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).");
    }
    async stop() {
        throw new Error("PgBossQueueStub: the pg-boss adapter is delivered in tickets 02/05 (JobQueue port stub for M0 foundation).");
    }
}
exports.PgBossQueueStub = PgBossQueueStub;
//# sourceMappingURL=pgboss.js.map