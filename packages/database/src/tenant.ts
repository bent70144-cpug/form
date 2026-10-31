import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { isUuid } from "./uuid";
import {
  createPool,
  markTenantTransactionClient,
  type CreatePoolOptions,
} from "./pool";

export type FormDrizzle = NodePgDatabase<Record<string, never>>;

/**
 * Transaction wrapper (spec: "Each request runs in a transaction that sets
 * `app.workspace_id` transaction-locally with `set_config(..., true)`. A
 * repository wrapper refuses tenant queries executed outside that transaction.").
 *
 * `withTenantTransaction` opens a transaction on a pooled client, sets
 * `app.user_id` and `app.workspace_id` with `set_config(..., true)` so the
 * settings vanish at COMMIT/ROLLBACK (no leakage across pooled reuse), and
 * hands the callback a `TenantDb` handle. Tenant repositories must take this
 * handle — nothing else may touch tenant tables (see pool.ts guard).
 */

export interface TenantContext {
  /** Verified session user ID (set from the session, never from the client). */
  userId: string;
  /** Active workspace ID (derived server-side, never from the client). */
  workspaceId: string;
}

export interface TenantDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  /** Drizzle instance bound to the transaction client. */
  drizzle: FormDrizzle;
  context: TenantContext;
}

export interface AdminDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  drizzle: FormDrizzle;
}

function assertUuid(value: string, name: string): void {
  if (!isUuid(value)) {
    throw new Error(
      `withTenantTransaction: ${name} must be a UUID (got "${value ? `${value.slice(0, 8)}…` : "empty"}")`,
    );
  }
}

export async function withTenantTransaction<T>(
  pool: Pool,
  context: TenantContext,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  assertUuid(context.userId, "userId");
  assertUuid(context.workspaceId, "workspaceId");

  const client = await pool.connect();
  // From BEGIN until COMMIT/ROLLBACK the guard allows tenant-table queries.
  markTenantTransactionClient(client);
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [context.userId, context.workspaceId],
    );
    const tx: TenantDb = {
      query: (text, values) => client.query(text, values),
      drizzle: drizzle(client) as unknown as FormDrizzle,
      context,
    };
    let result: T;
    try {
      result = await fn(tx);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/**
 * Transaction without tenant context, for non-tenant operations (health
 * checks, outbox maintenance). The tenant-query guard still applies: reaching
 * a tenant table here is a defect, not a pattern to allow.
 */
export async function withAdminTransaction<T>(
  pool: Pool,
  fn: (tx: AdminDb) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx: AdminDb = {
      query: (text, values) => client.query(text, values),
      drizzle: drizzle(client) as unknown as FormDrizzle,
    };
    let result: T;
    try {
      result = await fn(tx);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/** Re-exported so callers can create guard-enabled pools from one import. */
export { createPool, type CreatePoolOptions, type PoolClient };
