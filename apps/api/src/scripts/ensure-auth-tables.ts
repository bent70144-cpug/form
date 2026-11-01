import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";

/**
 * Dev/alpha-only: apply Better Auth's compiled DDL for the `auth` schema.
 *
 * WHY THIS EXISTS (found by the ticket-12 smoke): the SQL migrations own the
 * `app` schema, but the `auth` tables are Better Auth's own generated DDL —
 * the API test fixture applies them at test time ("test-time equivalent of
 * the production migrator step — ADR 0003") and on a real deploy the
 * migrator step owns them. The local supervisor's `--dev` flow had no
 * equivalent, so a freshly bootstrapped dev database could not sign anyone
 * up (signup 500, 42501 relation-missing). This script is that missing
 * migrator step for local dev; the smoke runs it as part of the boot.
 *
 * Runs as the ADMIN (like the one-time bootstrap) because table creation in
 * `auth` belongs to the admin/migrator, never to app_user. Idempotent:
 * Better Auth's migration runner tracks its own applied migrations inside
 * the schema, so re-running is a no-op.
 *
 * Env:
 *   ADMIN_DATABASE_URL  required — admin connection to the dev database
 *   AUTH_SCHEMA         optional — defaults to "auth"
 */
async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    process.stderr.write(
      "ensure-auth-tables: ADMIN_DATABASE_URL is required (run as the admin, like db:bootstrap)\n",
    );
    process.exit(1);
  }
  const schemaName = process.env.AUTH_SCHEMA ?? "auth";

  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });
  try {
    const { runMigrations } = await getMigrations(
      {
        database: { db: kysely, type: "postgres", schemaName },
        plugins: [],
        rateLimit: { enabled: false },
      } as never,
      { throwOnUnsafe: false },
    );
    await runMigrations();

    // Runtime DML grants for app_user (same grant set as the API test
    // fixture — no CREATE, no ownership: RLS and the catalog guard hold).
    const grantor = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      for (const sql of [
        `GRANT USAGE ON SCHEMA ${schemaName} TO app_user`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO app_user`,
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaName} TO app_user`,
      ]) {
        await grantor.query(sql);
      }
    } finally {
      await grantor.end();
    }
    process.stdout.write(
      `auth schema "${schemaName}" ready (DDL + app_user DML grants)\n`,
    );
  } finally {
    // kysely.destroy() ends the pool it was constructed with — ending it here
    // as well throws "Called end on pool more than once".
    await kysely.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `ensure-auth-tables failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
