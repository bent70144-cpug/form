"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const embedded_1 = require("../testing/embedded");
/**
 * `pnpm db:start` — boots the embedded Postgres substitute on 127.0.0.1:5433
 * and keeps it running until interrupted (SIGINT/SIGTERM stop it gracefully).
 * Safe to run when a server is already listening (it exits without error).
 */
async function main() {
    if (await (0, embedded_1.isPostgresReachable)()) {
        process.stdout.write(`A Postgres server is already listening on 127.0.0.1:5433 — nothing to do.\n`);
        return;
    }
    const { port, started } = await (0, embedded_1.ensureEmbeddedPostgres)();
    if (!started) {
        process.stdout.write(`Postgres became available on port ${port}.\n`);
        return;
    }
    process.stdout.write([
        `Embedded Postgres running on 127.0.0.1:${port}`,
        `  data dir: ${"os" in globalThis ? "(see docs)" : ""}`,
        `  databases: form_dev, form_test (user: postgres)`,
        `Press Ctrl+C to stop.`,
        "",
    ].join("\n"));
    const shutdown = () => {
        process.stdout.write("\nStopping embedded Postgres…\n");
        void stopAndExit();
    };
    async function stopAndExit() {
        const { stopEmbeddedPostgres } = await Promise.resolve().then(() => __importStar(require("../testing/embedded")));
        await stopEmbeddedPostgres();
        process.exit(0);
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Keep the process alive for as long as Postgres runs.
    setInterval(() => undefined, 60_000);
}
main().catch((error) => {
    process.stderr.write(`db:start failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=start-embedded.js.map