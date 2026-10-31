import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  assertCatalogIntact,
  CatalogGuardError,
  runCatalogGuard,
  bootstrapDatabase,
  runMigrations,
} from "../src";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  testRoleUrl,
  TEST_PASSWORDS,
  EMBEDDED_PG,
} from "../src/testing";

/**
 * Catalog guard tests (ticket 05): the guard must pass on a fully migrated
 * database and FAIL with precise violations when a tenant table escapes
 * forced RLS, both-clause policies, or composite tenant foreign keys.
 */

const MIGRATOR_URL = testRoleUrl("migrator", EMBEDDED_PG.testDatabase);

beforeAll(async () => {
  await ensureBootstrapped();
});

describe("catalog guard on a migrated database", () => {
  it("passes: every tenant table has forced RLS, both-clause policies, composite FKs", async () => {
    const client = new Client({ connectionString: MIGRATOR_URL });
    await client.connect();
    try {
      const violations = await runCatalogGuard(client);
      expect(violations).toEqual([]);
      await assertCatalogIntact(client); // no throw
    } finally {
      await client.end();
    }
  });

  it("covers all tenant tables including the special-cased workspaces", async () => {
    const client = new Client({ connectionString: MIGRATOR_URL });
    await client.connect();
    try {
      const res = await client.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relkind = 'r'
            AND (EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'workspace_id')
                 OR c.relname = 'workspaces')`,
      );
      const guarded = res.rows.map((r) => r.relname).sort();
      expect(guarded).toEqual(
        [
          "audit_logs",
          "form_drafts",
          "form_sessions",
          "form_slugs",
          "form_versions",
          "forms",
          "projects",
          "submissions",
          "workspace_invitations",
          "workspace_members",
          "workspaces",
        ].sort(),
      );
    } finally {
      await client.end();
    }
  });
});

describe("catalog guard against a sabotaged scratch database", () => {
  const SCRATCH = "t05_catalog_scratch";
  let scratchUrl: string;

  beforeAll(async () => {
    await dropDatabase(SCRATCH);
    scratchUrl = await createScratchDatabase(SCRATCH);
    await bootstrapDatabase({
      adminUrl: scratchUrl,
      migratorPassword: TEST_PASSWORDS.migrator,
      appUserPassword: TEST_PASSWORDS.appUser,
      workerPassword: TEST_PASSWORDS.worker,
    });
    await runMigrations({
      databaseUrl: testRoleUrl("migrator", SCRATCH),
    });
  });

  afterAll(async () => {
    await dropDatabase(SCRATCH);
  });

  it("lists a rogue tenant table without RLS, policies, or composite FKs", async () => {
    const migrator = new Client({
      connectionString: testRoleUrl("migrator", SCRATCH),
    });
    await migrator.connect();
    try {
      // Sabotage 1: a tenant-shaped table with NO RLS at all.
      await migrator.query(
        `CREATE TABLE app.rogue (
           id uuid PRIMARY KEY,
           workspace_id uuid NOT NULL
         )`,
      );
      // Sabotage 2: a tenant table whose workspace_id FK skips the
      // (workspace_id, id) composite and points straight at forms(id).
      await migrator.query(
        `CREATE TABLE app.rogue_bypass (
           id uuid PRIMARY KEY,
           workspace_id uuid NOT NULL REFERENCES app.forms(id)
         )`,
      );
      await migrator.query(
        `ALTER TABLE app.rogue_bypass ENABLE ROW LEVEL SECURITY;
         ALTER TABLE app.rogue_bypass FORCE ROW LEVEL SECURITY`,
      );
      await migrator.query(
        `CREATE POLICY rogue_bypass_rls ON app.rogue_bypass
           USING (true) WITH CHECK (true)`,
      );

      const violations = await runCatalogGuard(migrator);
      const rogue = violations.filter((v) => v.table === "app.rogue");
      expect(rogue.map((v) => v.check).sort()).toEqual([
        "forced_rls",
        "policy_clauses",
      ]);
      const bypass = violations.filter((v) => v.table === "app.rogue_bypass");
      expect(bypass.map((v) => v.check)).toEqual(["composite_fk"]);
      expect(bypass[0]!.detail).toMatch(/forms\(id\)/);

      await expect(assertCatalogIntact(migrator)).rejects.toBeInstanceOf(
        CatalogGuardError,
      );
      await expect(assertCatalogIntact(migrator)).rejects.toThrow(
        /app\.rogue\b/,
      );
    } finally {
      await migrator.end();
    }
  });

  it("a policy with USING but no WITH CHECK fails the policy_clauses check", async () => {
    const migrator = new Client({
      connectionString: testRoleUrl("migrator", SCRATCH),
    });
    await migrator.connect();
    try {
      await migrator.query(
        `CREATE TABLE app.rogue_using_only (
           id uuid PRIMARY KEY,
           workspace_id uuid NOT NULL
         )`,
      );
      await migrator.query(
        `ALTER TABLE app.rogue_using_only ENABLE ROW LEVEL SECURITY;
         ALTER TABLE app.rogue_using_only FORCE ROW LEVEL SECURITY`,
      );
      // USING alone is insufficient (spec): WITH CHECK missing.
      await migrator.query(
        `CREATE POLICY rogue_using_only_rls ON app.rogue_using_only
           USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)`,
      );

      const violations = await runCatalogGuard(migrator);
      const rows = violations.filter(
        (v) => v.table === "app.rogue_using_only" && v.check === "policy_clauses",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toMatch(/WITH CHECK/);
    } finally {
      await migrator.end();
    }
  });
});
