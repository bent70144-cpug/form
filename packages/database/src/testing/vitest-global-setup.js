"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = globalSetup;
const embedded_1 = require("./embedded");
/**
 * Vitest globalSetup: boots the embedded Postgres once per test run on
 * localhost:5433 and tears it down afterwards. If a server is already
 * listening (dev supervisor / `pnpm db:start`), it is reused and NOT stopped.
 */
async function globalSetup(_context) {
    const { started } = await (0, embedded_1.ensureEmbeddedPostgres)();
    if (!started)
        return;
    return async () => {
        await (0, embedded_1.stopEmbeddedPostgres)();
    };
}
//# sourceMappingURL=vitest-global-setup.js.map