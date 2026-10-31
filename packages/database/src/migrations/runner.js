"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const pool_1 = require("../pool");
/**
 * SQL migration runner (spec: "Migrations run as the `migrator` table owner;
 * they create tables, RLS policies, functions, and grants").
 *
 * - Plain `.sql` files from `packages/database/migrations`, applied in name
 *   order, each in its own transaction.
 * - Applied files are tracked in `app.migrations` (created by migration 0001);
 *   the runner treats a missing bookkeeping table as "nothing applied yet".
 * - Applied files are checksum-verified; drift fails loudly.
 * - Connects as the migrator role with the tenant guard disabled (migrations
 *   legitimately touch tenant table names before the tables exist).
 */
function defaultMigrationsDir() {
    // `__dirname` exists in the CJS build and under tsx/vite-node execution;
    // fall back to the package root relative to the working directory otherwise
    // (root scripts and package scripts both resolve to the same directory).
    if (typeof __dirname !== "undefined") {
        return node_path_1.default.resolve(__dirname, "..", "..", "migrations");
    }
    const candidates = [
        node_path_1.default.resolve(process.cwd(), "packages", "database", "migrations"),
        node_path_1.default.resolve(process.cwd(), "migrations"),
    ];
    return candidates.find((candidate) => node_fs_1.default.existsSync(candidate)) ?? candidates[0];
}
const MIGRATIONS_DIR = defaultMigrationsDir();
function loadMigrations(dir) {
    return node_fs_1.default
        .readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((name) => {
        const sql = node_fs_1.default.readFileSync(node_path_1.default.join(dir, name), "utf8");
        return { name, sql, checksum: sha256(sql) };
    });
}
function sha256(input) {
    return (0, node_crypto_1.createHash)("sha256").update(input).digest("hex");
}
async function runMigrations(options) {
    const dir = options.dir ?? MIGRATIONS_DIR;
    const files = loadMigrations(dir);
    const pool = (0, pool_1.createPool)(options.databaseUrl, { tenantGuard: false });
    const applied = [];
    try {
        const tableExists = await pool.query("SELECT to_regclass('app.migrations')::text AS reg");
        const trackingReady = tableExists.rows[0]?.reg !== null;
        const alreadyApplied = new Map();
        if (trackingReady) {
            const rows = await pool.query("SELECT name, checksum FROM app.migrations");
            for (const row of rows.rows)
                alreadyApplied.set(row.name, row.checksum);
        }
        if (options.verifyChecksums !== false &&
            trackingReady &&
            alreadyApplied.size > 0) {
            for (const file of files) {
                const recorded = alreadyApplied.get(file.name);
                if (recorded !== undefined && recorded !== file.checksum) {
                    throw new Error(`Migration ${file.name} changed since it was applied (checksum mismatch). Migrations are immutable; add a new file instead.`);
                }
            }
        }
        for (const file of files) {
            if (alreadyApplied.has(file.name))
                continue;
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(file.sql);
                // 0001 creates the bookkeeping table inside this same transaction, so
                // by the time we insert, the table always exists.
                await client.query("INSERT INTO app.migrations (name, checksum) VALUES ($1, $2)", [file.name, file.checksum]);
                await client.query("COMMIT");
                applied.push(file.name);
            }
            catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw new Error(`Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            finally {
                client.release();
            }
        }
        return { applied, skipped: files.length - applied.length };
    }
    finally {
        await pool.end();
    }
}
//# sourceMappingURL=runner.js.map