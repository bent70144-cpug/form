"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("@form/config");
const bootstrap_1 = require("../bootstrap");
/**
 * One-time admin bootstrap CLI (`pnpm db:bootstrap`).
 *
 * Requires ADMIN_DATABASE_URL plus the three role passwords from the
 * environment. NEVER runs as part of migrations or app startup.
 */
async function main() {
    const env = (0, config_1.loadEnv)(config_1.bootstrapEnvSchema);
    const summary = await (0, bootstrap_1.bootstrapDatabase)({
        adminUrl: env.ADMIN_DATABASE_URL,
        migratorPassword: env.MIGRATOR_PASSWORD,
        appUserPassword: env.APP_USER_PASSWORD,
        workerPassword: env.WORKER_PASSWORD,
    });
    process.stdout.write([
        `Database: ${summary.database}`,
        `Roles created: ${summary.createdRoles.join(", ") || "(none — already present)"}`,
        `Roles aligned: ${summary.alignedRoles.join(", ") || "(none)"}`,
        `Schemas: ${summary.schemas.join(", ")}`,
        `fn_owner granted to migrator (WITH ADMIN OPTION): ${summary.fnOwnerMembershipGranted ? "yes" : "already held"}`,
        "",
    ].join("\n"));
}
main().catch((error) => {
    process.stderr.write(`db:bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=bootstrap.js.map