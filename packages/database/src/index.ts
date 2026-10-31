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
export {
  createPool,
  markTenantTransactionClient,
  TenantQueryOutsideTransactionError,
  type CreatePoolOptions,
} from "./pool";
export {
  withTenantTransaction,
  withUserTransaction,
  withAdminTransaction,
  type TenantContext,
  type TenantDb,
  type UserDb,
  type AdminDb,
  type FormDrizzle,
} from "./tenant";
export { createDrizzle, schema } from "./drizzle";
export { runMigrations, type RunMigrationsResult } from "./migrations/runner";
export {
  bootstrapDatabase,
  type BootstrapOptions,
  type BootstrapSummary,
} from "./bootstrap";
export { uuidv7, isUuid } from "./uuid";
export { TENANT_TABLES, isTenantQuery, type TenantTable } from "./tenant-tables";
export {
  runCatalogGuard,
  assertCatalogIntact,
  CatalogGuardError,
  type CatalogCheck,
  type CatalogViolation,
} from "./catalog-guard";
export {
  appSchema,
  authSchema,
  pgbossSchema,
  workspaceRole,
  formStatus,
  appTables,
  workspaces,
  workspaceMembers,
  workspaceInvitations,
  projects,
  auditLogs,
  outboxEvents,
  forms,
  formDrafts,
  formVersions,
  formSlugs,
  formSessions,
  submissions,
} from "./schema";
