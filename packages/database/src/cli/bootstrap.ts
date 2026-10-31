import { loadEnv, bootstrapEnvSchema } from "@form/config";
import { bootstrapDatabase } from "../bootstrap";

/**
 * One-time admin bootstrap CLI (`pnpm db:bootstrap`).
 *
 * Requires ADMIN_DATABASE_URL plus the three role passwords from the
 * environment. NEVER runs as part of migrations or app startup.
 */
async function main(): Promise<void> {
  const env = loadEnv(bootstrapEnvSchema);
  const summary = await bootstrapDatabase({
    adminUrl: env.ADMIN_DATABASE_URL,
    migratorPassword: env.MIGRATOR_PASSWORD,
    appUserPassword: env.APP_USER_PASSWORD,
    workerPassword: env.WORKER_PASSWORD,
  });
  process.stdout.write(
    [
      `Database: ${summary.database}`,
      `Roles created: ${summary.createdRoles.join(", ") || "(none — already present)"}`,
      `Roles aligned: ${summary.alignedRoles.join(", ") || "(none)"}`,
      `Schemas: ${summary.schemas.join(", ")}`,
      `fn_owner granted to migrator (WITH ADMIN OPTION): ${summary.fnOwnerMembershipGranted ? "yes" : "already held"}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `db:bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
