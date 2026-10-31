import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPool } from "../src";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  TEST_PASSWORDS,
  EMBEDDED_PG,
} from "../src/testing";

/**
 * Role-grant seam tests (spec Testing Decisions, seam 3): the request role is
 * real Postgres least privilege, not an application convention. `app_user`
 * connects, gets DML via default privileges, and cannot create objects.
 */

beforeAll(async () => {
  await ensureBootstrapped();
});

describe("app_user least privilege", () => {
  it("connects and runs plain SELECTs", async () => {
    const pool = createPool(testRoleUrl("app_user", EMBEDDED_PG.testDatabase), {
      max: 2,
    });
    try {
      const res = await pool.query<{ who: string; one: number }>(
        "SELECT current_user AS who, 1 AS one",
      );
      expect(res.rows[0]!.who).toBe("app_user");
    } finally {
      await pool.end();
    }
  });

  it("cannot create schemas or tables", async () => {
    const pool = createPool(testRoleUrl("app_user", EMBEDDED_PG.testDatabase), {
      max: 1,
    });
    try {
      await expect(
        pool.query("CREATE SCHEMA rogue_schema"),
      ).rejects.toHaveProperty("code", "42501");
      await expect(
        pool.query("CREATE TABLE app.rogue_table (id int)"),
      ).rejects.toHaveProperty("code", "42501");
    } finally {
      await pool.end();
    }
  });

  it("receives DML grants on migrator-created tables via default privileges", async () => {
    // Migrator creates a probe table in app; default privileges from 0001
    // must grant app_user DML on it automatically.
    const migrator = new Client({
      connectionString: testRoleUrl("migrator", EMBEDDED_PG.testDatabase),
    });
    await migrator.connect();
    try {
      await migrator.query(
        "CREATE TABLE IF NOT EXISTS app.default_privilege_probe (id int PRIMARY KEY, note text)",
      );
    } finally {
      await migrator.end();
    }

    const appUser = createPool(
      testRoleUrl("app_user", EMBEDDED_PG.testDatabase),
      { max: 1 },
    );
    try {
      await appUser.query(
        "INSERT INTO app.default_privilege_probe (id, note) VALUES (1, 'dml-ok') ON CONFLICT (id) DO NOTHING",
      );
      const read = await appUser.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.default_privilege_probe",
      );
      expect(Number(read.rows[0]!.count)).toBeGreaterThanOrEqual(1);
      await appUser.query("DELETE FROM app.default_privilege_probe");
    } finally {
      await appUser.end();
      const cleanup = new Client({
        connectionString: testRoleUrl("migrator", EMBEDDED_PG.testDatabase),
      });
      await cleanup.connect();
      try {
        await cleanup.query("DROP TABLE IF EXISTS app.default_privilege_probe");
      } finally {
        await cleanup.end();
      }
    }
  });

  it("can read the migrations bookkeeping table (explicit grant in 0001)", async () => {
    const pool = createPool(
      testRoleUrl("app_user", EMBEDDED_PG.testDatabase),
      { max: 1 },
    );
    try {
      const res = await pool.query<{ name: string }>(
        "SELECT name FROM app.migrations",
      );
      expect(res.rows.map((r) => r.name)).toContain("0001_foundation.sql");
    } finally {
      await pool.end();
    }
  });
});

describe("worker_user separation", () => {
  it("connects under its own role, distinct from app_user", async () => {
    const pool = createPool(
      testRoleUrl("worker_user", EMBEDDED_PG.testDatabase),
      { max: 1 },
    );
    try {
      const res = await pool.query<{ who: string }>("SELECT current_user AS who");
      expect(res.rows[0]!.who).toBe("worker_user");
    } finally {
      await pool.end();
    }
  });
});

describe("bootstrap against a fresh scratch database", () => {
  const SCRATCH = "t01_roles_scratch";

  afterAll(async () => {
    await dropDatabase(SCRATCH);
  });

  it("schemas are per-database: a new database bootstraps cleanly", async () => {
    await dropDatabase(SCRATCH);
    const scratchUrl = await createScratchDatabase(SCRATCH);
    const { bootstrapDatabase } = await import("../src/bootstrap");
    const summary = await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });
    expect(summary.createdRoles).toHaveLength(0); // roles are cluster-wide
    expect(summary.schemas).toEqual(["app", "auth", "pgboss"]);
    expect(summary.fnOwnerMembershipGranted).toBe(false);

    const appUser = new Client({
      connectionString: testRoleUrl("app_user", SCRATCH),
    });
    await appUser.connect();
    try {
      const res = await appUser.query<{ who: string; db: string }>(
        "SELECT current_user AS who, current_database() AS db",
      );
      expect(res.rows[0]!.who).toBe("app_user");
      expect(res.rows[0]!.db).toBe(SCRATCH);
    } finally {
      await appUser.end();
    }
  });
});
