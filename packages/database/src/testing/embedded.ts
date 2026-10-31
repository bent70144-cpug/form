import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import EmbeddedPostgres from "embedded-postgres";

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

export const EMBEDDED_PG = {
  host: "127.0.0.1",
  port: 5433,
  user: "postgres",
  password: "postgres",
  adminDatabase: "postgres",
  devDatabase: "form_dev",
  testDatabase: "form_test",
} as const;

const DATA_DIR = path.join(os.tmpdir(), "form-embedded-pg");
const PID_FILE = path.join(os.tmpdir(), "form-embedded-pg.pid");

let handle: EmbeddedPostgres | null = null;

export function adminUrl(database: string = EMBEDDED_PG.adminDatabase): string {
  return `postgres://${EMBEDDED_PG.user}:${EMBEDDED_PG.password}@${EMBEDDED_PG.host}:${EMBEDDED_PG.port}/${database}`;
}

export async function isPostgresReachable(
  port: number = EMBEDDED_PG.port,
): Promise<boolean> {
  try {
    const client = new Client({
      host: EMBEDDED_PG.host,
      port,
      user: EMBEDDED_PG.user,
      password: EMBEDDED_PG.password,
      database: EMBEDDED_PG.adminDatabase,
      connectionTimeoutMillis: 800,
    });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: EMBEDDED_PG.host });
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

export interface EmbeddedPgHandle {
  started: boolean;
  port: number;
}

/**
 * Boot the embedded cluster unless something already answers on the port.
 * Returns whether THIS process started it (only the starter tears it down).
 */
export async function ensureEmbeddedPostgres(): Promise<EmbeddedPgHandle> {
  if (await isPostgresReachable()) {
    return { started: false, port: EMBEDDED_PG.port };
  }
  if (await isPortOpen(EMBEDDED_PG.port)) {
    // Something non-Postgres occupies the port — fail with a clear message.
    throw new Error(
      `Port ${EMBEDDED_PG.port} is occupied by a non-Postgres process; free it or set a different fixture port.`,
    );
  }

  // Simple lock so two processes cannot initdb the same directory concurrently.
  const lockFile = `${PID_FILE}.lock`;
  const fd = fs.openSync(lockFile, "wx");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const needsInit = !fs.existsSync(path.join(DATA_DIR, "PG_VERSION"));
    handle = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      user: EMBEDDED_PG.user,
      password: EMBEDDED_PG.password,
      port: EMBEDDED_PG.port,
      persistent: true,
    });
    if (needsInit) {
      await handle.initialise();
    }
    await handle.start();
    for (const db of [EMBEDDED_PG.devDatabase, EMBEDDED_PG.testDatabase]) {
      try {
        await handle.createDatabase(db);
      } catch {
        // already exists from a previous run — fine
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
    return { started: true, port: EMBEDDED_PG.port };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  }
}

export async function stopEmbeddedPostgres(): Promise<void> {
  if (handle) {
    await handle.stop();
    handle = null;
    fs.rmSync(PID_FILE, { force: true });
  }
}

/** PID of the process that booted the cluster, if recorded. */
export function embeddedPgOwnerPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
