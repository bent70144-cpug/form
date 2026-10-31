"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMBEDDED_PG = void 0;
exports.adminUrl = adminUrl;
exports.isPostgresReachable = isPostgresReachable;
exports.ensureEmbeddedPostgres = ensureEmbeddedPostgres;
exports.stopEmbeddedPostgres = stopEmbeddedPostgres;
exports.embeddedPgOwnerPid = embeddedPgOwnerPid;
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const pg_1 = require("pg");
const embedded_postgres_1 = __importDefault(require("embedded-postgres"));
/**
 * Embedded Postgres fixture (spec-sanctioned Docker substitute — see
 * docs/adr/0001-local-infra-substitutes.md).
 *
 * Boots REAL PostgreSQL 17 binaries on 127.0.0.1:5433 (user `postgres`,
 * password `postgres`). Tests use the real non-superuser roles created by the
 * bootstrap; the initdb superuser only plays the admin for that one-time
 * bootstrap. The fixture reuses a server that is already listening (dev
 * supervisor or `pnpm db:start`) so a single instance serves dev + tests.
 */
exports.EMBEDDED_PG = {
    host: "127.0.0.1",
    port: 5433,
    user: "postgres",
    password: "postgres",
    adminDatabase: "postgres",
    devDatabase: "form_dev",
    testDatabase: "form_test",
};
const DATA_DIR = node_path_1.default.join(node_os_1.default.tmpdir(), "form-embedded-pg");
const PID_FILE = node_path_1.default.join(node_os_1.default.tmpdir(), "form-embedded-pg.pid");
let handle = null;
function adminUrl(database = exports.EMBEDDED_PG.adminDatabase) {
    return `postgres://${exports.EMBEDDED_PG.user}:${exports.EMBEDDED_PG.password}@${exports.EMBEDDED_PG.host}:${exports.EMBEDDED_PG.port}/${database}`;
}
async function isPostgresReachable(port = exports.EMBEDDED_PG.port) {
    try {
        const client = new pg_1.Client({
            host: exports.EMBEDDED_PG.host,
            port,
            user: exports.EMBEDDED_PG.user,
            password: exports.EMBEDDED_PG.password,
            database: exports.EMBEDDED_PG.adminDatabase,
            connectionTimeoutMillis: 800,
        });
        await client.connect();
        await client.end();
        return true;
    }
    catch {
        return false;
    }
}
function isPortOpen(port) {
    return new Promise((resolve) => {
        const socket = node_net_1.default.connect({ port, host: exports.EMBEDDED_PG.host });
        socket.setTimeout(500);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => resolve(false));
    });
}
/**
 * Boot the embedded cluster unless something already answers on the port.
 * Returns whether THIS process started it (only the starter tears it down).
 */
async function ensureEmbeddedPostgres() {
    if (await isPostgresReachable()) {
        return { started: false, port: exports.EMBEDDED_PG.port };
    }
    if (await isPortOpen(exports.EMBEDDED_PG.port)) {
        // Something non-Postgres occupies the port — fail with a clear message.
        throw new Error(`Port ${exports.EMBEDDED_PG.port} is occupied by a non-Postgres process; free it or set a different fixture port.`);
    }
    // Simple lock so two processes cannot initdb the same directory concurrently.
    const lockFile = `${PID_FILE}.lock`;
    const fd = node_fs_1.default.openSync(lockFile, "wx");
    try {
        node_fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
        const needsInit = !node_fs_1.default.existsSync(node_path_1.default.join(DATA_DIR, "PG_VERSION"));
        handle = new embedded_postgres_1.default({
            databaseDir: DATA_DIR,
            user: exports.EMBEDDED_PG.user,
            password: exports.EMBEDDED_PG.password,
            port: exports.EMBEDDED_PG.port,
            persistent: true,
        });
        if (needsInit) {
            await handle.initialise();
        }
        await handle.start();
        for (const db of [exports.EMBEDDED_PG.devDatabase, exports.EMBEDDED_PG.testDatabase]) {
            try {
                await handle.createDatabase(db);
            }
            catch {
                // already exists from a previous run — fine
            }
        }
        node_fs_1.default.writeFileSync(PID_FILE, String(process.pid));
        return { started: true, port: exports.EMBEDDED_PG.port };
    }
    finally {
        node_fs_1.default.closeSync(fd);
        node_fs_1.default.rmSync(lockFile, { force: true });
    }
}
async function stopEmbeddedPostgres() {
    if (handle) {
        await handle.stop();
        handle = null;
        node_fs_1.default.rmSync(PID_FILE, { force: true });
    }
}
/** PID of the process that booted the cluster, if recorded. */
function embeddedPgOwnerPid() {
    try {
        const raw = node_fs_1.default.readFileSync(PID_FILE, "utf8").trim();
        const pid = Number(raw);
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=embedded.js.map