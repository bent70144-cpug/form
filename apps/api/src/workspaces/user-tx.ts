import type { Pool, PoolClient } from "pg";
import { isUuid } from "@form/database";

/**
 * Narrower request context for routes that have NO workspace yet
 * (spec, ticket 05: "bootstrap runs with only `app.user_id`, and
 * `create_personal_workspace()` sets `app.workspace_id` internally once
 * the workspace exists").
 *
 * `withUserTransaction` opens a transaction on the pooled app_user client
 * and sets ONLY `app.user_id` with `set_config(..., true)` so the setting
 * vanishes at COMMIT/ROLLBACK (no leakage across pooled reuse). Statements
 * on this handle must go through security-definer functions
 * (`create_personal_workspace()`, `list_workspaces()`) — the underlying
 * tables carry no direct grants for app_user.
 */
export async function withUserTransaction<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isUuid(userId)) {
    throw new Error(
      `withUserTransaction: userId must be a UUID (got "${userId ? userId.slice(0, 8) + "…" : "empty"}")`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    let result: T;
    try {
      result = await fn(client);
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
