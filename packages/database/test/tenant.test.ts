import { beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  TenantQueryOutsideTransactionError,
  withAdminTransaction,
  withTenantTransaction,
  withUserTransaction,
} from "../src";
import {
  ensureBootstrapped,
  testRoleUrl,
  EMBEDDED_PG,
} from "../src/testing";

const USER_ID = "0b8f6c1e-8f3a-4d2e-9a1b-2c3d4e5f6a7b";
const WS_ID = "1a2b3c4d-5e6f-4a4b-8c8d-9e0f1a2b3c4d";

// max=1 so the "after the transaction" probe is guaranteed to reuse the SAME
// pooled client — the spec's pooled-connection context-leak assertion.
const appUserUrl = testRoleUrl("app_user", EMBEDDED_PG.testDatabase);

beforeAll(async () => {
  // Self-sufficient regardless of file order on a fresh cluster.
  await ensureBootstrapped();
});

describe("tenant query guard", () => {
  it("refuses tenant-table queries outside a tenant transaction", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await expect(
        pool.query("SELECT * FROM workspaces LIMIT 1"),
      ).rejects.toBeInstanceOf(TenantQueryOutsideTransactionError);
      await expect(
        pool.query("UPDATE submissions SET deleted_at = now()"),
      ).rejects.toBeInstanceOf(TenantQueryOutsideTransactionError);
    } finally {
      await pool.end();
    }
  });

  it("allows non-tenant queries outside a transaction", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      const res = await pool.query<{ one: number }>("SELECT 1 AS one");
      expect(res.rows[0]!.one).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe("withTenantTransaction", () => {
  it("sets app.user_id and app.workspace_id transaction-locally", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await withTenantTransaction(
        pool,
        { userId: USER_ID, workspaceId: WS_ID },
        async (tx) => {
          const res = await tx.query<{
            uid: string | null;
            wid: string | null;
            local: string;
          }>(
            `SELECT current_setting('app.user_id', true) AS uid,
                    current_setting('app.workspace_id', true) AS wid,
                    current_setting('transaction_local_probe', true) IS NULL AS local`,
          );
          expect(res.rows[0]!.uid).toBe(USER_ID);
          expect(res.rows[0]!.wid).toBe(WS_ID);
        },
      );
    } finally {
      await pool.end();
    }
  });

  it("leaves no residue on the pooled client after COMMIT (no leak)", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await withTenantTransaction(
        pool,
        { userId: USER_ID, workspaceId: WS_ID },
        async (tx) => {
          await tx.query("SELECT 1");
        },
      );
      const after = await pool.query<{ wid: string | null; uid: string | null }>(
        `SELECT current_setting('app.workspace_id', true) AS wid,
                current_setting('app.user_id', true) AS uid`,
      );
      // nullif-style consumers must see empty/NULL, not a stale tenant.
      expect(after.rows[0]!.wid === "" || after.rows[0]!.wid === null).toBe(
        true,
      );
      expect(after.rows[0]!.uid === "" || after.rows[0]!.uid === null).toBe(
        true,
      );
    } finally {
      await pool.end();
    }
  });

  it("rolls back on failure and still leaves no residue", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await expect(
        withTenantTransaction(
          pool,
          { userId: USER_ID, workspaceId: WS_ID },
          async (tx) => {
            await tx.query("SELECT 1");
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow("boom");
      const after = await pool.query<{ wid: string | null }>(
        "SELECT current_setting('app.workspace_id', true) AS wid",
      );
      expect(after.rows[0]!.wid === "" || after.rows[0]!.wid === null).toBe(
        true,
      );
    } finally {
      await pool.end();
    }
  });

  it("rejects non-UUID context values up front", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await expect(
        withTenantTransaction(
          pool,
          { userId: "not-a-uuid", workspaceId: WS_ID },
          async () => undefined,
        ),
      ).rejects.toThrow(/userId must be a UUID/);
    } finally {
      await pool.end();
    }
  });
});

describe("withUserTransaction", () => {
  it("sets ONLY app.user_id; withWorkspace() widens to a tenant handle transaction-locally", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await withUserTransaction(pool, USER_ID, async (tx) => {
        const narrow = await tx.query<{ uid: string | null; wid: string | null }>(
          `SELECT current_setting('app.user_id', true) AS uid,
                  current_setting('app.workspace_id', true) AS wid`,
        );
        expect(narrow.rows[0]!.uid).toBe(USER_ID);
        expect(narrow.rows[0]!.wid === "" || narrow.rows[0]!.wid === null).toBe(true);

        const tenant = await tx.withWorkspace(WS_ID);
        expect(tenant.context).toEqual({ userId: USER_ID, workspaceId: WS_ID });
        const widened = await tenant.query<{ wid: string | null }>(
          "SELECT current_setting('app.workspace_id', true) AS wid",
        );
        expect(widened.rows[0]!.wid).toBe(WS_ID);
      });
      // Transaction-local: nothing survives COMMIT.
      const after = await pool.query<{ wid: string | null }>(
        "SELECT current_setting('app.workspace_id', true) AS wid",
      );
      expect(after.rows[0]!.wid === "" || after.rows[0]!.wid === null).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("rejects non-UUID values for the user and the widened workspace", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await expect(
        withUserTransaction(pool, "nope", async () => undefined),
      ).rejects.toThrow(/userId must be a UUID/);
      await withUserTransaction(pool, USER_ID, async (tx) => {
        await expect(tx.withWorkspace("nope")).rejects.toThrow(
          /workspaceId must be a UUID/,
        );
      });
    } finally {
      await pool.end();
    }
  });
});

describe("withAdminTransaction", () => {
  it("runs without tenant settings and the tenant guard still applies", async () => {
    const pool = createPool(appUserUrl, { max: 1 });
    try {
      await expect(
        withAdminTransaction(pool, async (tx) => {
          const res = await tx.query<{ uid: string | null }>(
            "SELECT current_setting('app.user_id', true) AS uid",
          );
          expect(res.rows[0]!.uid === "" || res.rows[0]!.uid === null).toBe(
            true,
          );
          // Reaching a tenant table outside a TENANT transaction is a defect
          // — the guard fires even inside an admin transaction (pool.ts).
          await tx.query("SELECT * FROM forms LIMIT 1");
        }),
      ).rejects.toBeInstanceOf(TenantQueryOutsideTransactionError);
    } finally {
      await pool.end();
    }
  });
});
