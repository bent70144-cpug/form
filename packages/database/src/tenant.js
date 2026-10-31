"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPool = void 0;
exports.withTenantTransaction = withTenantTransaction;
exports.withAdminTransaction = withAdminTransaction;
const node_postgres_1 = require("drizzle-orm/node-postgres");
const uuid_1 = require("./uuid");
const pool_1 = require("./pool");
Object.defineProperty(exports, "createPool", { enumerable: true, get: function () { return pool_1.createPool; } });
function assertUuid(value, name) {
    if (!(0, uuid_1.isUuid)(value)) {
        throw new Error(`withTenantTransaction: ${name} must be a UUID (got "${value ? `${value.slice(0, 8)}…` : "empty"}")`);
    }
}
async function withTenantTransaction(pool, context, fn) {
    assertUuid(context.userId, "userId");
    assertUuid(context.workspaceId, "workspaceId");
    const client = await pool.connect();
    // From BEGIN until COMMIT/ROLLBACK the guard allows tenant-table queries.
    (0, pool_1.markTenantTransactionClient)(client);
    try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [context.userId, context.workspaceId]);
        const tx = {
            query: (text, values) => client.query(text, values),
            drizzle: (0, node_postgres_1.drizzle)(client),
            context,
        };
        let result;
        try {
            result = await fn(tx);
        }
        catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        }
        await client.query("COMMIT");
        return result;
    }
    finally {
        client.release();
    }
}
/**
 * Transaction without tenant context, for non-tenant operations (health
 * checks, outbox maintenance). The tenant-query guard still applies: reaching
 * a tenant table here is a defect, not a pattern to allow.
 */
async function withAdminTransaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const tx = {
            query: (text, values) => client.query(text, values),
            drizzle: (0, node_postgres_1.drizzle)(client),
        };
        let result;
        try {
            result = await fn(tx);
        }
        catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        }
        await client.query("COMMIT");
        return result;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=tenant.js.map