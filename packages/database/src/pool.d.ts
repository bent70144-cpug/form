import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
/**
 * Pooled connection factory with the tenant-query guard.
 *
 * Spec: "A repository wrapper refuses tenant queries executed outside that
 * transaction." The guard intercepts every query on every pooled client and
 * rejects statements that reference a tenant table unless the client is inside
 * a `withTenantTransaction` block. Tenant repositories must therefore take the
 * wrapper's `TenantDb` handle — a plain pool query for tenant tables throws.
 */
export declare class TenantQueryOutsideTransactionError extends Error {
    constructor(sql: string);
}
export interface CreatePoolOptions {
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    /** Disable the guard for infrastructure connections (migrator runner). */
    tenantGuard?: boolean;
}
export declare function createPool(connectionString: string, options?: CreatePoolOptions): Pool;
/** Marks a client as being inside a tenant transaction. */
export declare function markTenantTransactionClient(client: PoolClient): void;
export type { QueryResult, QueryResultRow };
//# sourceMappingURL=pool.d.ts.map