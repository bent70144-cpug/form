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
exports.TEST_PASSWORDS = void 0;
exports.testRoleUrl = testRoleUrl;
exports.ensureBootstrapped = ensureBootstrapped;
exports.createScratchDatabase = createScratchDatabase;
exports.dropDatabase = dropDatabase;
const index_1 = require("../index");
const embedded_1 = require("./embedded");
/**
 * Shared test fixture helpers: deterministic test passwords and an idempotent
 * "bootstrap + migrate" step suites can call. Tests always exercise the REAL
 * roles (`migrator`, `app_user`, `worker_user`, NOLOGIN `fn_owner`) — never a
 * weakened superuser path.
 */
exports.TEST_PASSWORDS = {
    migrator: "test-migrator-pw",
    appUser: "test-app-user-pw",
    worker: "test-worker-pw",
};
function testRoleUrl(role, database = embedded_1.EMBEDDED_PG.testDatabase) {
    const password = role === "migrator"
        ? exports.TEST_PASSWORDS.migrator
        : role === "app_user"
            ? exports.TEST_PASSWORDS.appUser
            : exports.TEST_PASSWORDS.worker;
    return `postgres://${role}:${encodeURIComponent(password)}@${embedded_1.EMBEDDED_PG.host}:${embedded_1.EMBEDDED_PG.port}/${database}`;
}
/**
 * Idempotent: run in every suite's beforeAll. Performs the one-time admin
 * bootstrap and applies migrations (skipping already-applied ones).
 */
async function ensureBootstrapped(database = embedded_1.EMBEDDED_PG.testDatabase) {
    const adminDbUrl = (0, embedded_1.adminUrl)(database);
    await (0, index_1.bootstrapDatabase)({
        adminUrl: adminDbUrl,
        migratorPassword: exports.TEST_PASSWORDS.migrator,
        appUserPassword: exports.TEST_PASSWORDS.appUser,
        workerPassword: exports.TEST_PASSWORDS.worker,
    });
    await (0, index_1.runMigrations)({ databaseUrl: testRoleUrl("migrator", database) });
    return {
        adminUrl: adminDbUrl,
        migratorUrl: testRoleUrl("migrator", database),
        appUserUrl: testRoleUrl("app_user", database),
        workerUrl: testRoleUrl("worker_user", database),
    };
}
/** Creates an empty scratch database for a test that must not share state. */
async function createScratchDatabase(name) {
    const { Client } = await Promise.resolve().then(() => __importStar(require("pg")));
    const client = new Client({ connectionString: (0, embedded_1.adminUrl)() });
    await client.connect();
    try {
        const exists = await client.query("SELECT datname FROM pg_database WHERE datname = $1", [name]);
        if (exists.rows.length === 0) {
            await client.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
        }
        return (0, embedded_1.adminUrl)(name);
    }
    finally {
        await client.end();
    }
}
async function dropDatabase(name) {
    const { Client } = await Promise.resolve().then(() => __importStar(require("pg")));
    const client = new Client({ connectionString: (0, embedded_1.adminUrl)() });
    await client.connect();
    try {
        await client
            .query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, "")}"`)
            .catch(() => undefined);
    }
    finally {
        await client.end();
    }
}
//# sourceMappingURL=fixture.js.map