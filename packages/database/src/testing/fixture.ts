import {
  bootstrapDatabase,
  runMigrations,
} from "../index";
import { adminUrl, EMBEDDED_PG } from "./embedded";

/**
 * Shared test fixture helpers: deterministic test passwords and an idempotent
 * "bootstrap + migrate" step suites can call. Tests always exercise the REAL
 * roles (`migrator`, `app_user`, `worker_user`, NOLOGIN `fn_owner`) — never a
 * weakened superuser path.
 */

export const TEST_PASSWORDS = {
  migrator: "test-migrator-pw",
  appUser: "test-app-user-pw",
  worker: "test-worker-pw",
} as const;

export function testRoleUrl(
  role: "migrator" | "app_user" | "worker_user",
  database: string = EMBEDDED_PG.testDatabase,
): string {
  const password =
    role === "migrator"
      ? TEST_PASSWORDS.migrator
      : role === "app_user"
        ? TEST_PASSWORDS.appUser
        : TEST_PASSWORDS.worker;
  return `postgres://${role}:${encodeURIComponent(password)}@${EMBEDDED_PG.host}:${EMBEDDED_PG.port}/${database}`;
}

export interface BootstrappedUrls {
  adminUrl: string;
  migratorUrl: string;
  appUserUrl: string;
  workerUrl: string;
}

/**
 * Idempotent: run in every suite's beforeAll. Performs the one-time admin
 * bootstrap and applies migrations (skipping already-applied ones).
 */
export async function ensureBootstrapped(
  database: string = EMBEDDED_PG.testDatabase,
): Promise<BootstrappedUrls> {
  const adminDbUrl = adminUrl(database);
  await bootstrapDatabase({
    adminUrl: adminDbUrl,
    migratorPassword: TEST_PASSWORDS.migrator,
    appUserPassword: TEST_PASSWORDS.appUser,
    workerPassword: TEST_PASSWORDS.worker,
  });
  await runMigrations({ databaseUrl: testRoleUrl("migrator", database) });
  return {
    adminUrl: adminDbUrl,
    migratorUrl: testRoleUrl("migrator", database),
    appUserUrl: testRoleUrl("app_user", database),
    workerUrl: testRoleUrl("worker_user", database),
  };
}

/** Creates an empty scratch database for a test that must not share state. */
export async function createScratchDatabase(
  name: string,
): Promise<string> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const exists = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [name],
    );
    if (exists.rows.length === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
    }
    return adminUrl(name);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client
      .query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, "")}"`)
      .catch(() => undefined);
  } finally {
    await client.end();
  }
}
