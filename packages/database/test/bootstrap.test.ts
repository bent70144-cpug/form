import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { bootstrapDatabase } from "../src/bootstrap";
import {
  createScratchDatabase,
  dropDatabase,
  TEST_PASSWORDS,
} from "../src/testing";

const SCRATCH = "t01_bootstrap_scratch";
const ROLES = ["migrator", "app_user", "worker_user", "fn_owner"] as const;

let scratchUrl: string;

async function roleRow(admin: Client, name: string) {
  const res = await admin.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
       FROM pg_roles WHERE rolname = $1`,
    [name],
  );
  return res.rows[0];
}

beforeAll(async () => {
  await dropDatabase(SCRATCH);
  scratchUrl = await createScratchDatabase(SCRATCH);
});

afterAll(async () => {
  await dropDatabase(SCRATCH);
});

describe("bootstrapDatabase", () => {
  it("creates the four roles with least-privilege attributes", async () => {
    const summary = await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });

    // Roles are cluster-wide and may pre-exist on a persistent test cluster;
    // what matters is that all four EXIST with least-privilege attributes.
    expect([...summary.createdRoles, ...summary.alignedRoles].sort()).toEqual(
      ["app_user", "fn_owner", "migrator", "worker_user"].sort(),
    );
    expect(summary.schemas).toEqual(["app", "auth", "pgboss"]);

    const admin = new Client({ connectionString: scratchUrl });
    await admin.connect();
    try {
      for (const name of ROLES) {
        const row = await roleRow(admin, name);
        expect(row, `role ${name} exists`).toBeDefined();
        expect(row!.rolsuper, `${name} is not superuser`).toBe(false);
        expect(row!.rolbypassrls, `${name} has NOBYPASSRLS`).toBe(false);
        expect(row!.rolcreaterole, `${name} cannot create roles`).toBe(false);
        expect(row!.rolcreatedb, `${name} cannot create databases`).toBe(false);
      }
      expect((await roleRow(admin, "fn_owner"))!.rolcanlogin).toBe(false);
      for (const name of ["migrator", "app_user", "worker_user"]) {
        expect((await roleRow(admin, name))!.rolcanlogin).toBe(true);
      }

      const schemas = await admin.query<{ nspname: string; owner: string }>(
        `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
           FROM pg_namespace n WHERE n.nspname = ANY($1::text[])`,
        [["app", "auth", "pgboss"]],
      );
      expect(schemas.rows).toHaveLength(3);
      for (const row of schemas.rows) expect(row.owner).toBe("migrator");
    } finally {
      await admin.end();
    }
  });

  it("grants fn_owner to migrator WITH ADMIN OPTION", async () => {
    await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });
    // The migrator can SET ROLE fn_owner (requires membership + admin right).
    const migrator = new Client({
      connectionString: `postgres://migrator:${TEST_PASSWORDS.migrator}@127.0.0.1:5433/${SCRATCH}`,
    });
    await migrator.connect();
    try {
      await migrator.query("SET ROLE fn_owner");
      const who = await migrator.query<{ role: string }>(
        "SELECT current_user AS role",
      );
      expect(who.rows[0]!.role).toBe("fn_owner");
      await migrator.query("RESET ROLE");
    } finally {
      await migrator.end();
    }
  });

  it("is idempotent: a second run aligns instead of duplicating", async () => {
    const first = await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });
    const second = await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });
    expect(second.createdRoles).toHaveLength(0);
    expect(second.alignedRoles.sort()).toEqual(
      ["app_user", "fn_owner", "migrator", "worker_user"].sort(),
    );
    expect(second.fnOwnerMembershipGranted).toBe(false);
    expect(first.database).toBe(SCRATCH);
    expect(second.database).toBe(SCRATCH);
  });
});
