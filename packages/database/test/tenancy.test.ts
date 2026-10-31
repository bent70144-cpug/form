import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapPersonalWorkspace,
  connectAs,
  newId,
  withTenant,
  withUserContext,
  RUN,
} from "./helpers";

/**
 * Ticket 05 domain slice: workspace bootstrap, forced-RLS tenancy, composite
 * foreign keys, and the audit/outbox grant matrix — all against REAL roles.
 */

let USER_A: string;
let USER_B: string;
let WS_A: string;
let WS_B: string;
const FORM_A = { id: "" };

beforeAll(async () => {
  USER_A = newId();
  USER_B = newId();
  WS_A = await bootstrapPersonalWorkspace(USER_A);
  WS_B = await bootstrapPersonalWorkspace(USER_B);

  // One form in workspace A, created through the request role with A's
  // tenant context (RLS WITH CHECK must accept it).
  FORM_A.id = newId();
  await withTenant(USER_A, WS_A, async (tx) => {
    await tx.query(
      `INSERT INTO app.forms (id, workspace_id, project_id, name, created_by)
       SELECT $1::uuid, $2::uuid, p.id, 'Form A', $3::uuid
         FROM app.projects p
        WHERE p.workspace_id = $2::uuid AND p.is_default`,
      [FORM_A.id, WS_A, USER_A],
    );
  });
});

describe("create_personal_workspace", () => {
  it("creates the workspace, owner membership, and default General project atomically", async () => {
    const userId = newId();
    const ws = await bootstrapPersonalWorkspace(userId);
    expect(ws).toMatch(/^[0-9a-f-]{36}$/);

    // The sanctioned read path: list_workspaces(), not direct table reads.
    const listed = await withUserContext(userId, (client) =>
      client.query<{ id: string; name: string; role: string }>(
        "SELECT id::text AS id, name, role::text AS role FROM app.list_workspaces()",
      ),
    );
    expect(listed.rows).toEqual([
      { id: ws, name: "Personal Workspace", role: "owner" },
    ]);

    await withTenant(userId, ws, async (tx) => {
      const projects = await tx.query<{ name: string }>(
        "SELECT name FROM app.projects WHERE is_default AND deleted_at IS NULL",
      );
      expect(projects.rows).toEqual([{ name: "General" }]);
    });
  });

  it("writes the workspace.created audit row and outbox event after the first bootstrap", async () => {
    const userId = newId();
    const ws = await bootstrapPersonalWorkspace(userId);

    await withTenant(userId, ws, async (tx) => {
      const audit = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.audit_logs WHERE action = 'workspace.created' AND workspace_id = $1::uuid",
        [ws],
      );
      expect(Number(audit.rows[0]!.count)).toBe(1);
    });

    // Outbox is read by the worker role (app_user has no SELECT grant).
    const worker = await connectAs("worker_user");
    try {
      const events = await worker.query<{ payload: { workspaceId: string; userId: string } }>(
        "SELECT payload FROM app.outbox_events WHERE event_type = 'workspace.created' AND payload->>'workspaceId' = $1",
        [ws],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]!.payload.userId).toBe(userId);
      // No workspace_id column exists on outbox_events — the id travels in
      // the payload only.
      const columns = await worker.query<{ attname: string }>(
        `SELECT a.attname FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relname = 'outbox_events'
           AND a.attname = 'workspace_id'`,
      );
      expect(columns.rows).toHaveLength(0);
    } finally {
      await worker.end();
    }
  });

  it("is idempotent: a repeated bootstrap returns the same workspace and duplicates nothing", async () => {
    const userId = newId();
    const first = await bootstrapPersonalWorkspace(userId);
    const second = await bootstrapPersonalWorkspace(userId);
    expect(second).toBe(first);

    await withTenant(userId, first, async (tx) => {
      const audit = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.audit_logs WHERE action = 'workspace.created' AND workspace_id = $1::uuid",
        [first],
      );
      expect(Number(audit.rows[0]!.count)).toBe(1);

      const memberships = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.projects WHERE workspace_id = $1::uuid",
        [first],
      );
      expect(Number(memberships.rows[0]!.count)).toBe(1);
    });

    const worker = await connectAs("worker_user");
    try {
      const events = await worker.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.outbox_events WHERE event_type = 'workspace.created' AND payload->>'workspaceId' = $1",
        [first],
      );
      expect(Number(events.rows[0]!.count)).toBe(1);
    } finally {
      await worker.end();
    }
  });

  it("keeps workspaces and workspace_members reachable ONLY through the functions", async () => {
    const appUser = await connectAs("app_user");
    try {
      // No direct SELECT grant: 42501 permission denied, not merely empty.
      await expect(
        appUser.query("SELECT * FROM app.workspaces"),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        appUser.query("SELECT * FROM app.workspace_members"),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await appUser.end();
    }
  });
});

describe("forced RLS tenancy", () => {
  it("gives workspace B zero rows of workspace A, in both directions", async () => {
    await withTenant(USER_B, WS_B, async (tx) => {
      const all = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.forms",
      );
      expect(Number(all.rows[0]!.count)).toBe(0);
    });
    // A still sees exactly its own form.
    await withTenant(USER_A, WS_A, async (tx) => {
      const own = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.forms WHERE id = $1::uuid",
        [FORM_A.id],
      );
      expect(Number(own.rows[0]!.count)).toBe(1);
    });
  });

  it("rejects an UPDATE that moves a row's workspace_id to another tenant", async () => {
    await withTenant(USER_A, WS_A, async (tx) => {
      await expect(
        tx.query("UPDATE app.forms SET workspace_id = $1::uuid WHERE id = $2::uuid", [
          WS_B,
          FORM_A.id,
        ]),
      ).rejects.toHaveProperty("code", "42501");
    });
    // The row never moved.
    await withTenant(USER_A, WS_A, async (tx) => {
      const row = await tx.query<{ workspace_id: string }>(
        "SELECT workspace_id::text FROM app.forms WHERE id = $1::uuid",
        [FORM_A.id],
      );
      expect(row.rows[0]!.workspace_id).toBe(WS_A);
    });
  });

  it("cross-tenant writes are silently scoped to zero rows, not leaked", async () => {
    await withTenant(USER_B, WS_B, async (tx) => {
      const res = await tx.query(
        "UPDATE app.forms SET name = 'hijacked' WHERE id = $1::uuid",
        [FORM_A.id],
      );
      expect(res.rowCount).toBe(0);
    });
  });

  it("a query without tenant context returns no rows (nullif, not a cast error)", async () => {
    const appUser = await connectAs("app_user");
    try {
      const res = await appUser.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.forms",
      );
      expect(Number(res.rows[0]!.count)).toBe(0);
    } finally {
      await appUser.end();
    }
  });
});

describe("composite tenant foreign keys", () => {
  it("a form cannot reference another workspace's project (23503)", async () => {
    const projB = await withTenant(USER_B, WS_B, async (tx) => {
      const res = await tx.query<{ id: string }>(
        "SELECT id::text AS id FROM app.projects WHERE is_default AND deleted_at IS NULL",
      );
      return res.rows[0]!.id;
    });

    await withTenant(USER_A, WS_A, async (tx) => {
      await expect(
        tx.query(
          `INSERT INTO app.forms (id, workspace_id, project_id, name)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Cross-tenant')`,
          [newId(), WS_A, projB],
        ),
      ).rejects.toHaveProperty("code", "23503");
    });
  });

  it("every tenant child FK is composite (workspace_id, parent_id)", async () => {
    const migrator = await connectAs("migrator");
    try {
      const fks = await migrator.query<{
        child: string;
        fk_columns: string[];
        parent: string;
        ref_columns: string[];
      }>(
        `SELECT con.conrelid::regclass::text AS child,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ) AS fk_columns,
                con.confrelid::regclass::text AS parent,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                ) AS ref_columns
           FROM pg_constraint con
           JOIN pg_namespace n ON n.oid = con.connamespace
          WHERE n.nspname = 'app' AND con.contype = 'f'`,
      );
      const tenantFks = fks.rows.filter((r) =>
        r.fk_columns.includes("workspace_id"),
      );
      // Every FK that involves workspace_id is either the root link to
      // workspaces(id) or a composite (workspace_id, <parent id>).
      for (const fk of tenantFks) {
        if (fk.fk_columns.length === 1) {
          expect(fk.parent, `${fk.child} root link`).toBe("app.workspaces");
          expect(fk.ref_columns).toEqual(["id"]);
        } else {
          expect(fk.fk_columns[0]).toBe("workspace_id");
          expect(fk.ref_columns).toEqual(["workspace_id", "id"]);
        }
      }
      // And there ARE composite ones (the invariant is exercised).
      const composites = tenantFks.filter((r) => r.fk_columns.length > 1);
      expect(composites.length).toBeGreaterThanOrEqual(10);
    } finally {
      await migrator.end();
    }
  });
});

describe("audit_logs is append-only", () => {
  const action = `test.audit.probe.${RUN}`;

  it("app_user can INSERT and SELECT within its workspace but never UPDATE/DELETE", async () => {
    await withTenant(USER_A, WS_A, async (tx) => {
      await tx.query(
        `INSERT INTO app.audit_logs (id, workspace_id, actor, action, target_type, target_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'form', $5::text)`,
        [newId(), WS_A, USER_A, action, FORM_A.id],
      );
      const read = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.audit_logs WHERE action = $1",
        [action],
      );
      expect(Number(read.rows[0]!.count)).toBe(1);
    });

    await withTenant(USER_A, WS_A, async (tx) => {
      await expect(
        tx.query("UPDATE app.audit_logs SET action = 'tampered' WHERE action = $1", [
          action,
        ]),
      ).rejects.toHaveProperty("code", "42501");
    });
    await withTenant(USER_A, WS_A, async (tx) => {
      await expect(
        tx.query("DELETE FROM app.audit_logs WHERE action = $1", [action]),
      ).rejects.toHaveProperty("code", "42501");
    });
  });

  it("another workspace cannot read A's audit rows (forced RLS)", async () => {
    await withTenant(USER_B, WS_B, async (tx) => {
      const read = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.audit_logs WHERE action = $1",
        [action],
      );
      expect(Number(read.rows[0]!.count)).toBe(0);
    });
  });
});

describe("outbox_events grant matrix", () => {
  const eventType = `test.event.${RUN}`;

  it("app_user inserts WITHOUT RETURNING and has no SELECT/UPDATE", async () => {
    const appUser = await connectAs("app_user");
    try {
      // Plain INSERT — no RETURNING clause anywhere (no SELECT grant).
      await appUser.query(
        `INSERT INTO app.outbox_events (id, event_type, payload)
         VALUES ($1::uuid, $2, $3::jsonb)`,
        [newId(), eventType, JSON.stringify({ workspaceId: WS_A, note: "probe" })],
      );
      await expect(
        appUser.query("SELECT * FROM app.outbox_events"),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        appUser.query(
          "INSERT INTO app.outbox_events (id, event_type, payload) VALUES ($1::uuid, 'x', '{}'::jsonb) RETURNING id",
          [newId()],
        ),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await appUser.end();
    }
  });

  it("worker_user selects and updates for dispatch, but cannot insert or delete", async () => {
    const worker = await connectAs("worker_user");
    try {
      const read = await worker.query<{ id: string; attempts: number }>(
        "SELECT id::text AS id, attempts FROM app.outbox_events WHERE event_type = $1 AND processed_at IS NULL",
        [eventType],
      );
      expect(read.rows).toHaveLength(1);

      await worker.query(
        "UPDATE app.outbox_events SET attempts = attempts + 1, processed_at = now() WHERE event_type = $1",
        [eventType],
      );
      const after = await worker.query<{ attempts: number; count: string }>(
        "SELECT attempts, count(*)::text AS count FROM app.outbox_events WHERE event_type = $1 AND processed_at IS NOT NULL GROUP BY attempts",
        [eventType],
      );
      expect(after.rows[0]!.attempts).toBe(1);

      await expect(
        worker.query(
          "INSERT INTO app.outbox_events (id, event_type, payload) VALUES ($1::uuid, 'x', '{}'::jsonb)",
          [newId()],
        ),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        worker.query("DELETE FROM app.outbox_events WHERE event_type = $1", [
          eventType,
        ]),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await worker.end();
    }
  });
});
