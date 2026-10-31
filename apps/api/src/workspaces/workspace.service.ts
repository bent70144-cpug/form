import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { workspaceSchema, type Workspace } from "@form/contracts";
import { APP_DB_POOL } from "../db/app-db";
import { withUserTransaction } from "./user-tx";

/**
 * Workspace bootstrap + active-workspace resolution (ticket 05).
 *
 * Every statement runs as the pooled `app_user` through the
 * security-definer seam (migration 0006): `create_personal_workspace()` and
 * `list_workspaces()` read `app.user_id` from the transaction, never a
 * caller-supplied ID, and the underlying `workspaces` / `workspace_members`
 * tables have no direct grants for `app_user`. Responses are validated
 * against the shared Zod contracts so the wire shape cannot drift.
 */
@Injectable()
export class WorkspaceService {
  constructor(@Inject(APP_DB_POOL) private readonly pool: Pool) {}

  /**
   * `POST /v1/workspaces/bootstrap` body: idempotent. Opens a transaction
   * with ONLY `app.user_id` set (no workspace exists yet), calls the
   * security-definer `create_personal_workspace()` — which creates the
   * personal workspace, owner membership, `is_default` General project,
   * the `workspace.created` audit row and outbox event exactly once, and
   * sets `app.workspace_id` internally — then resolves the workspace
   * shape via `list_workspaces()` in the SAME transaction.
   */
  async bootstrapPersonal(userId: string): Promise<Workspace> {
    return withUserTransaction(this.pool, userId, async (client) => {
      const created = await client.query<{ id: string }>(
        "SELECT app.create_personal_workspace()::text AS id",
      );
      const row = created.rows[0];
      if (!row) {
        throw new Error("create_personal_workspace() returned no row");
      }
      const listing = await this.listWorkspacesOn(client);
      const workspace = listing.find((w) => w.id === row.id);
      if (!workspace) {
        throw new Error(
          "workspace bootstrap: created workspace missing from list_workspaces()",
        );
      }
      return workspace;
    });
  }

  /**
   * Active workspace for the session endpoint and the tenant request
   * context: the user's single personal workspace (M0 — multi-workspace
   * selection is deferred). Resolved through the security-definer
   * `list_workspaces()` with only `app.user_id` set — NEVER a direct RLS
   * membership query. Read-only: no workspace is created here.
   */
  async resolveActiveWorkspace(userId: string): Promise<Workspace | null> {
    return withUserTransaction(this.pool, userId, (client) =>
      this.listWorkspacesOn(client).then((rows) => rows[0] ?? null),
    );
  }

  private async listWorkspacesOn(client: PoolClient): Promise<Workspace[]> {
    const result = await client.query<{
      id: string;
      name: string;
      role: string;
    }>("SELECT id, name, role FROM app.list_workspaces()");
    // Contract validation: id UUID + role within the workspace_role enum.
    return result.rows.map((row) => workspaceSchema.parse(row));
  }
}
