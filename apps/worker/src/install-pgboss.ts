import { grantPgBossRuntimeRole, installPgBossSchema } from "@form/queue";

/**
 * Dev/test companion step (NOT a production path): installs the `pgboss`
 * schema DDL as the migrator and grants the runtime worker role DML-only
 * access. In production the DDL lives in a migration file owned by the
 * migrator, and the grants are part of migration 0001-style default
 * privileges — see docs/adr/0003-topology-spike.md and docs/adr/0005-outbox-dispatcher.md.
 *
 * The helpers live in @form/queue (the queue package owns pg-boss concerns);
 * this script is the CLI wrapper for local dev.
 *
 * Env: ADMIN_DATABASE_URL (grants), MIGRATOR_DATABASE_URL (DDL owner).
 */
async function main() {
  const migratorUrl = process.env.MIGRATOR_DATABASE_URL;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!migratorUrl || !adminUrl) {
    process.stderr.write(
      "[pgboss-install] ADMIN_DATABASE_URL and MIGRATOR_DATABASE_URL are required\n",
    );
    process.exit(1);
  }

  // 1. DDL as the migrator (createSchema:false — schema pre-created by the
  //    admin bootstrap; PG17 quirk: `CREATE SCHEMA IF NOT EXISTS` demands
  //    CREATE on the database even when the schema exists).
  await installPgBossSchema(migratorUrl);

  // 2. Runtime grants for worker_user (admin): DML + sequences + functions,
  //    no CREATE — the runtime role never migrates.
  await grantPgBossRuntimeRole(adminUrl);

  process.stdout.write(
    JSON.stringify({ event: "pgboss.install_ok", schema: "pgboss" }) + "\n",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[pgboss-install] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
