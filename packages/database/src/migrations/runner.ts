import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPool } from "../pool";

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

function defaultMigrationsDir(): string {
  // `__dirname` exists in the CJS build and under tsx/vite-node execution;
  // fall back to the package root relative to the working directory otherwise
  // (root scripts and package scripts both resolve to the same directory).
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..", "..", "migrations");
  }
  const candidates = [
    path.resolve(process.cwd(), "packages", "database", "migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export interface RunMigrationsOptions {
  /** Direct (non-pooled) connection string for the `migrator` role. */
  databaseUrl: string;
  /** Directory containing `NNNN_*.sql` files. */
  dir?: string;
  /** Fail when an already-applied file no longer matches its checksum. */
  verifyChecksums?: boolean;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: number;
}

const MIGRATIONS_DIR = defaultMigrationsDir();

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(dir: string): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: sha256(sql) };
    });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const files = loadMigrations(dir);
  const pool = createPool(options.databaseUrl, { tenantGuard: false });
  const applied: string[] = [];
  try {
    const tableExists = await pool.query<{ reg: string | null }>(
      "SELECT to_regclass('app.migrations')::text AS reg",
    );
    const trackingReady = tableExists.rows[0]?.reg !== null;

    const alreadyApplied = new Map<string, string>();
    if (trackingReady) {
      const rows = await pool.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM app.migrations",
      );
      for (const row of rows.rows) alreadyApplied.set(row.name, row.checksum);
    }

    if (
      options.verifyChecksums !== false &&
      trackingReady &&
      alreadyApplied.size > 0
    ) {
      for (const file of files) {
        const recorded = alreadyApplied.get(file.name);
        if (recorded !== undefined && recorded !== file.checksum) {
          throw new Error(
            `Migration ${file.name} changed since it was applied (checksum mismatch). Migrations are immutable; add a new file instead.`,
          );
        }
      }
    }

    for (const file of files) {
      if (alreadyApplied.has(file.name)) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(file.sql);
        // 0001 creates the bookkeeping table inside this same transaction, so
        // by the time we insert, the table always exists.
        await client.query(
          "INSERT INTO app.migrations (name, checksum) VALUES ($1, $2)",
          [file.name, file.checksum],
        );
        await client.query("COMMIT");
        applied.push(file.name);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(
          `Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        client.release();
      }
    }

    return { applied, skipped: files.length - applied.length };
  } finally {
    await pool.end();
  }
}
