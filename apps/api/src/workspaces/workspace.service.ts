import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { withUserTransaction } from "@form/database";
import type { WorkspaceRef } from "@form/contracts";
import { APP_POOL } from "./db";

/**
 * Workspace read/bootstrap operations (ticket 05). Everything here runs in
 * the NARROW user-only context and reaches tenant data exclusively through
 * the security-definer functions `list_workspaces()` and
 * `create_personal_workspace()` — never through direct table access (the
 * request role has no grants on workspaces/workspace_members anyway).
 */
@Injectable()
export class WorkspaceService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  /**
   * Resolves the active workspace via `list_workspaces()` (read-only). For M0
   * the active workspace is the user's single personal workspace, so the
   * first membership wins; multi-workspace selection is deferred.
   */
  async resolveActiveWorkspace(userId: string): Promise<WorkspaceRef | null> {
    return withUserTransaction(this.pool, userId, async (tx) => {
      const listed = await tx.query<{
        id: string;
        name: string;
        role: string;
      }>("SELECT id::text, name, role::text FROM app.list_workspaces()");
      const row = listed.rows[0];
      return row ? { id: row.id, name: row.name, role: row.role as WorkspaceRef["role"] } : null;
    });
  }

  /**
   * Idempotent bootstrap: calls `create_personal_workspace()` (which reads
   * `app.user_id`, creates workspace + owner membership + default General
   * project + `workspace.created` audit row and outbox event atomically, and
   * returns the EXISTING personal workspace on repeat — no duplicates, no
   * duplicate audit/outbox rows), then reads the workspace back through
   * `list_workspaces()` in the same transaction.
   */
  async bootstrap(userId: string): Promise<WorkspaceRef> {
    return withUserTransaction(this.pool, userId, async (tx) => {
      await tx.query("SELECT app.create_personal_workspace()");
      const listed = await tx.query<{
        id: string;
        name: string;
        role: string;
      }>("SELECT id::text, name, role::text FROM app.list_workspaces()");
      const row = listed.rows[0];
      if (!row) {
        // create_personal_workspace() returned without a membership: a
        // database-level invariant broke. Nothing was written that we can
        // act on — surface a stable 500.
        throw new Error(
          "bootstrap: create_personal_workspace() produced no membership",
        );
      }
      return { id: row.id, name: row.name, role: row.role as WorkspaceRef["role"] };
    });
  }
}
