import { loadEnv, migratorEnvSchema } from "@form/config";
import { runMigrations } from "../migrations/runner";

/** Migration runner CLI (`pnpm db:migrate`). Runs as the `migrator` role. */
async function main(): Promise<void> {
  const env = loadEnv(migratorEnvSchema);
  const result = await runMigrations({ databaseUrl: env.MIGRATOR_DATABASE_URL });
  process.stdout.write(
    [
      `Migrations applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}`,
      `Already applied: ${result.skipped}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `db:migrate failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
