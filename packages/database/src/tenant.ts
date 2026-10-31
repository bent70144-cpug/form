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

/**
 * Handle for the NARROW bootstrap context (ticket 05): a transaction with
 * ONLY `app.user_id` set — no workspace yet, so RLS hides every tenant row
 * and the only sanctioned writes go through security-definer functions
 * (`create_personal_workspace()`), which set `app.workspace_id`
 * transaction-locally themselves. `withWorkspace(workspaceId)` widens the
 * SAME transaction into a full `TenantDb` after a workspace has been
 * resolved (e.g. via `list_workspaces()`).
 */
export interface UserDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  /** Drizzle instance bound to the transaction client. */
  drizzle: FormDrizzle;
  userId: string;
  /**
   * Sets `app.workspace_id` transaction-locally (`set_config(..., true)`) and
   * returns the tenant-scoped handle for the remainder of the transaction.
   */
  withWorkspace(workspaceId: string): Promise<TenantDb>;
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
 * Narrow user-context transaction (ticket 05 bootstrap path): opens a
 * transaction, sets ONLY `app.user_id` transaction-locally, and hands the
 * callback a `UserDb`. The tenant-query guard is armed for the whole
 * transaction; until `withWorkspace()` is called RLS still hides every
 * tenant row (no `app.workspace_id`), so the narrow context can only act
 * through security-definer functions.
 */
export async function withUserTransaction<T>(
  pool: Pool,
  userId: string,
  fn: (tx: UserDb) => Promise<T>,
): Promise<T> {
  assertUuid(userId, "userId");

  const client = await pool.connect();
  markTenantTransactionClient(client);
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const tx: UserDb = {
      query: (text, values) => client.query(text, values),
      drizzle: drizzle(client) as unknown as FormDrizzle,
      userId,
      withWorkspace: async (workspaceId: string): Promise<TenantDb> => {
        assertUuid(workspaceId, "workspaceId");
        await client.query(
          "SELECT set_config('app.workspace_id', $1, true)",
          [workspaceId],
        );
        return {
          query: (text, values) => client.query(text, values),
          drizzle: tx.drizzle,
          context: { userId, workspaceId },
        };
      },
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
