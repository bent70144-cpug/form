"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("@form/config");
const runner_1 = require("../migrations/runner");
/** Migration runner CLI (`pnpm db:migrate`). Runs as the `migrator` role. */
async function main() {
    const env = (0, config_1.loadEnv)(config_1.migratorEnvSchema);
    const result = await (0, runner_1.runMigrations)({ databaseUrl: env.MIGRATOR_DATABASE_URL });
    process.stdout.write([
        `Migrations applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}`,
        `Already applied: ${result.skipped}`,
        "",
    ].join("\n"));
}
main().catch((error) => {
    process.stderr.write(`db:migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map