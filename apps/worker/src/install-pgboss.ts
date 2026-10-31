import { Client } from "pg";
import { PgBoss } from "pg-boss";

/**
 * Dev/test companion step (NOT a production path): installs the `pgboss`
 * schema DDL as the migrator and grants the runtime worker role DML-only
 * access. In production the DDL lives in a migration file owned by the
 * migrator, and the grants are part of migration 0001-style default
 * privileges — see docs/adr/0003-topology-spike.md.
 *
 * Env: ADMIN_DATABASE_URL (grants), MIGRATOR_DATABASE_URL (DDL owner),
 * WORKER_PASSWORD (worker_user password for the grants).
 */
async function main() {
  const migratorUrl = process.env.MIGRATOR_DATABASE_URL;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const workerPassword = process.env.WORKER_PASSWORD;
  if (!migratorUrl || !adminUrl || !workerPassword) {
    process.stderr.write(
      "[pgboss-install] ADMIN_DATABASE_URL, MIGRATOR_DATABASE_URL and WORKER_PASSWORD are required\n",
    );
    process.exit(1);
  }

  // 1. DDL as the migrator (createSchema:false — schema pre-created by the
  //    admin bootstrap; PG17 quirk: `CREATE SCHEMA IF NOT EXISTS` demands
  //    CREATE on the database even when the schema exists).
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: "pgboss",
    createSchema: false,
  });
  await boss.start();
  await boss.stop({ graceful: false, timeout: 2000 });

  // 2. Runtime grants for worker_user (admin): DML + sequences + functions,
  //    no CREATE — the runtime role never migrates.
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
  process.stdout.write(
    JSON.stringify({ event: "pgboss.install_ok", schema: "pgboss" }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`[pgboss-install] ${err?.message ?? err}\n`);
  process.exit(1);
});
