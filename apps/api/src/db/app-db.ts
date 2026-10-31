import type { Pool } from "pg";

/**
 * DI token for the pooled app_user connection used for tenant work
 * (bootstrap, tenant request context, session workspace reads).
 *
 * Created in createApiApp from the Zod-validated DATABASE_URL — which the
 * supervisor allowlists as the POOLED app_user URL (never the migrator URL).
 * The pool carries the tenant-query guard (createPool), so tenant-table
 * statements are only legal inside the wrappers' transactions.
 */
export const APP_DB_POOL = Symbol("APP_DB_POOL");

export type AppDbPool = Pool;
