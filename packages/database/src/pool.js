"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantQueryOutsideTransactionError = void 0;
exports.createPool = createPool;
exports.markTenantTransactionClient = markTenantTransactionClient;
const pg_1 = require("pg");
const tenant_tables_1 = require("./tenant-tables");
/**
 * Pooled connection factory with the tenant-query guard.
 *
 * Spec: "A repository wrapper refuses tenant queries executed outside that
 * transaction." The guard intercepts every query on every pooled client and
 * rejects statements that reference a tenant table unless the client is inside
 * a `withTenantTransaction` block. Tenant repositories must therefore take the
 * wrapper's `TenantDb` handle — a plain pool query for tenant tables throws.
 */
class TenantQueryOutsideTransactionError extends Error {
    constructor(sql) {
        super(`Refusing tenant query outside a tenant transaction (spec guardrail). Matched tenant table in: ${sql.slice(0, 200)}`);
        this.name = "TenantQueryOutsideTransactionError";
    }
}
exports.TenantQueryOutsideTransactionError = TenantQueryOutsideTransactionError;
/** Clients currently inside a tenant transaction. */
const tenantTxClients = new WeakSet();
function createPool(connectionString, options = {}) {
    const { tenantGuard = true, ...poolOptions } = options;
    const pool = new pg_1.Pool({
        connectionString,
        max: poolOptions.max ?? 10,
        idleTimeoutMillis: poolOptions.idleTimeoutMillis ?? 30_000,
        connectionTimeoutMillis: poolOptions.connectionTimeoutMillis ?? 5_000,
    });
    if (tenantGuard) {
        pool.on("connect", (client) => installTenantGuard(client));
    }
    return pool;
}
/** Marks a client as being inside a tenant transaction. */
function markTenantTransactionClient(client) {
    tenantTxClients.add(client);
}
function installTenantGuard(client) {
    const original = client.query.bind(client);
    const guarded = (...args) => {
        const first = args[0];
        const text = typeof first === "string" ? first : first?.text;
        if (typeof text === "string" &&
            (0, tenant_tables_1.isTenantQuery)(text) &&
            !tenantTxClients.has(client)) {
            throw new TenantQueryOutsideTransactionError(text);
        }
        return original(...args);
    };
    // pg's PoolClient.query is an overloaded method; the wrapper preserves the
    // call signature at runtime (strings, config objects, callbacks).
    client.query = guarded;
}
//# sourceMappingURL=pool.js.map