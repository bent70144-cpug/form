import { Client } from "pg";
import { PgBoss } from "pg-boss";

/**
 * pg-boss schema install + runtime grants (dev/test/bootstrap companion).
 *
 * In production the `pgboss` DDL is a migration owned by the migrator and the
 * grants ride migration 0001-style default privileges — this helper exists
 * for local dev (`pnpm db:start` companion), tests, and the sandbox runbook.
 * See apps/worker/src/install-pgboss.ts and docs/adr/0003-topology-spike.md.
 *
 * Spike finding (PostgreSQL 17): `CREATE SCHEMA IF NOT EXISTS` still demands
 * CREATE on the DATABASE even when the schema already exists, so the install
 * MUST run with `createSchema: false` — the `pgboss` schema is pre-created
 * and migrator-owned by the admin bootstrap.
 */

/** Runs pg-boss's DDL migration as the MIGRATOR (schema pre-created, `createSchema:false`). */
export async function installPgBossSchema(migratorUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: "pgboss",
    createSchema: false,
  });
  await boss.start(); // runs pg-boss's migration as the migrator
  await boss.stop({ graceful: false, timeout: 2000 });
}

/**
 * Runtime grants for worker_user (run as ADMIN): DML + sequences + functions
 * on the pgboss schema, no CREATE — the runtime role never migrates.
 */
export async function grantPgBossRuntimeRole(adminUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const sql of [
      `GRANT USAGE ON SCHEMA pgboss TO worker_user`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO worker_user`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO worker_user`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO worker_user`,
    ]) {
      await admin.query(sql);
    }
  } finally {
    await admin.end();
  }
}
