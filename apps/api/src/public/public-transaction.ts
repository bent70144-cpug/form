import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { markTenantTransactionClient } from "@form/database";

/**
 * Public-flow transaction wrapper (ticket 10) — the UNauthenticated counterpart
 * of `withTenantTransaction`. The public session/submit routes have NO user,
 * so the context carries ONLY `app.workspace_id` — and that value always comes
 * from the server-resolved form/session (security-definer functions), NEVER
 * from the client (spec: "app.workspace_id for public session creation and
 * submit is set from the resolved form, never from the client. A forged
 * workspace ID or header is ignored").
 *
 * Same guarantees as the tenant wrapper: the pooled client is marked for the
 * tenant-query guard, `set_config(..., true)` keeps the setting
 * transaction-local (no leakage across pooled reuse), and any thrown error
 * ROLLS BACK before the client is released.
 */
export interface PublicDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export async function withPublicTransaction<T>(
  pool: Pool,
  /** Workspace bound transaction-locally BEFORE the callback — or null when the callback resolves it itself (the submit path binds it from `resolve_form_session` before any tenant-table statement). */
  workspaceId: string | null,
  fn: (tx: PublicDb) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  markTenantTransactionClient(client);
  try {
    await client.query("BEGIN");
    if (workspaceId !== null) {
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
    }
    const tx: PublicDb = {
      query: (text, values) => (client as PoolClient).query(text, values),
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
