"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTenantQuery = exports.TENANT_TABLES = exports.isUuid = exports.uuidv7 = exports.bootstrapDatabase = exports.runMigrations = exports.schema = exports.createDrizzle = exports.withAdminTransaction = exports.withTenantTransaction = exports.TenantQueryOutsideTransactionError = exports.createPool = void 0;
/**
 * @form/database — the ONLY request-path package that touches Postgres
 * (explicit spec exceptions: the queue package owns the pg-boss adapter; the
 * auth package owns the `auth` schema).
 *
 * Exports:
 * - `createPool` — pooled connections with the tenant-query guard.
 * - `withTenantTransaction` / `withAdminTransaction` — transaction wrappers.
 * - `createDrizzle` — pool-level Drizzle for non-tenant queries.
 * - `runMigrations` — plain-SQL migration runner (migrator role).
 * - `bootstrapDatabase` — one-time admin bootstrap (schemas + roles).
 * - `uuidv7` — app-side time-sortable IDs.
 * - `TENANT_TABLES` / `isTenantQuery` — the tenant query guard's source list.
 */
var pool_1 = require("./pool");
Object.defineProperty(exports, "createPool", { enumerable: true, get: function () { return pool_1.createPool; } });
Object.defineProperty(exports, "TenantQueryOutsideTransactionError", { enumerable: true, get: function () { return pool_1.TenantQueryOutsideTransactionError; } });
var tenant_1 = require("./tenant");
Object.defineProperty(exports, "withTenantTransaction", { enumerable: true, get: function () { return tenant_1.withTenantTransaction; } });
Object.defineProperty(exports, "withAdminTransaction", { enumerable: true, get: function () { return tenant_1.withAdminTransaction; } });
var drizzle_1 = require("./drizzle");
Object.defineProperty(exports, "createDrizzle", { enumerable: true, get: function () { return drizzle_1.createDrizzle; } });
Object.defineProperty(exports, "schema", { enumerable: true, get: function () { return drizzle_1.schema; } });
var runner_1 = require("./migrations/runner");
Object.defineProperty(exports, "runMigrations", { enumerable: true, get: function () { return runner_1.runMigrations; } });
var bootstrap_1 = require("./bootstrap");
Object.defineProperty(exports, "bootstrapDatabase", { enumerable: true, get: function () { return bootstrap_1.bootstrapDatabase; } });
var uuid_1 = require("./uuid");
Object.defineProperty(exports, "uuidv7", { enumerable: true, get: function () { return uuid_1.uuidv7; } });
Object.defineProperty(exports, "isUuid", { enumerable: true, get: function () { return uuid_1.isUuid; } });
var tenant_tables_1 = require("./tenant-tables");
Object.defineProperty(exports, "TENANT_TABLES", { enumerable: true, get: function () { return tenant_tables_1.TENANT_TABLES; } });
Object.defineProperty(exports, "isTenantQuery", { enumerable: true, get: function () { return tenant_tables_1.isTenantQuery; } });
//# sourceMappingURL=index.js.map