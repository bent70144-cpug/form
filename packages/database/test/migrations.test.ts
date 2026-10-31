import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../src/bootstrap";
import { runMigrations } from "../src/migrations/runner";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  TEST_PASSWORDS,
} from "../src/testing";

let scratchUrl: string;

beforeAll(async () => {
  await ensureBootstrapped(); // form_test: roles + 0001 already applied there
  await dropDatabase("t01_migrations_scratch");
  scratchUrl = await createScratchDatabase("t01_migrations_scratch");
  // Schemas are per-database: the scratch DB needs its own bootstrap (roles
  // are cluster-wide and already exist, so this only creates the schemas).
  await bootstrapDatabase({
    adminUrl: scratchUrl,
    migratorPassword: TEST_PASSWORDS.migrator,
    appUserPassword: TEST_PASSWORDS.appUser,
    workerPassword: TEST_PASSWORDS.worker,
  });
});

afterAll(async () => {
  await dropDatabase("t01_migrations_scratch");
});

describe("runMigrations", () => {
  it("applies 0001_foundation.sql once and records it in app.migrations", async () => {
    // Migrations always run as the migrator role (never the admin).
    const first = await runMigrations({
      databaseUrl: testRoleUrl("migrator", "t01_migrations_scratch"),
    });
    expect(first.applied).toContain("0001_foundation.sql");

    const { Client } = await import("pg");
    const admin = new Client({ connectionString: scratchUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM app.migrations",
      );
      expect(rows.rows.map((r) => r.name)).toEqual(["0001_foundation.sql"]);
      expect(rows.rows[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await admin.end();
    }

    const second = await runMigrations({ databaseUrl: scratchUrl });
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toBe(1);
  });

  it("fails loudly when an applied migration file changes (checksum drift)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "form-mig-"));
    const file = path.join(dir, "0001_probe.sql");
    fs.writeFileSync(file, "CREATE TABLE app.probe_a (id int);\n");
    try {
      const migratorUrl = testRoleUrl("migrator", "t01_migrations_scratch");
      await runMigrations({ databaseUrl: migratorUrl, dir });
      fs.writeFileSync(file, "CREATE TABLE app.probe_b (id int);\n");
      await expect(
        runMigrations({ databaseUrl: migratorUrl, dir }),
      ).rejects.toThrow(/checksum mismatch/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      const { Client } = await import("pg");
      const admin = new Client({ connectionString: scratchUrl });
      await admin.connect();
      try {
        await admin.query("DROP TABLE IF EXISTS app.probe_a");
      } finally {
        await admin.end();
      }
    }
  });

  it("rolls back the whole file when a statement fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "form-mig-"));
    fs.writeFileSync(
      path.join(dir, "0001_broken.sql"),
      "CREATE TABLE app.ok_probe (id int);\nTHIS IS NOT SQL;\n",
    );
    try {
      await expect(
        runMigrations({
          databaseUrl: testRoleUrl("migrator", "t01_migrations_scratch"),
          dir,
        }),
      ).rejects.toThrow(/0001_broken\.sql failed/);
      const { Client } = await import("pg");
      const admin = new Client({ connectionString: scratchUrl });
      await admin.connect();
      try {
        const probe = await admin.query(
          "SELECT to_regclass('app.ok_probe')::text AS reg",
        );
        expect(probe.rows[0]!.reg).toBeNull(); // rolled back with the file
      } finally {
        await admin.end();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
