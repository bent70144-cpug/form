import { Client } from "pg";
import { createPool, uuidv7, withTenantTransaction, type TenantDb } from "../src";
import { testRoleUrl, EMBEDDED_PG } from "../src/testing";

/**
 * Shared helpers for the domain suites: REAL roles over the embedded
 * Postgres — app_user for request-path work, worker_user for outbox/purge,
 * migrator only for catalog inspection. No test ever connects as a superuser
 * to weaken a guarantee.
 */

export type TestRole = "migrator" | "app_user" | "worker_user";

export const DB = EMBEDDED_PG.testDatabase;

export function roleUrl(role: TestRole): string {
  return testRoleUrl(role, DB);
}

/** Run-scoped marker so re-runs against the persistent test DB stay isolated. */
export const RUN = Date.now().toString(36);

export function newId(): string {
  return uuidv7();
}

const SLUG_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random 10-char base62 slug (globally unique per run, per form_slugs). */
export function randomSlug(): string {
  let slug = "";
  for (let i = 0; i < 10; i++) {
    slug += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return slug;
}

export async function connectAs(role: TestRole): Promise<Client> {
  const client = new Client({ connectionString: roleUrl(role) });
  await client.connect();
  return client;
}

/**
 * Bootstrap flow exactly as the API would drive it: a transaction with ONLY
 * app.user_id set (no workspace yet), calling the security-definer function.
 */
export async function bootstrapPersonalWorkspace(userId: string): Promise<string> {
  const client = await connectAs("app_user");
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const res = await client.query<{ ws: string }>(
      "SELECT app.create_personal_workspace()::text AS ws",
    );
    await client.query("COMMIT");
    return res.rows[0]!.ws;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Tenant transaction through the wrapper (guard enabled, both settings set). */
export async function withTenant<T>(
  userId: string,
  workspaceId: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  const pool = createPool(roleUrl("app_user"), { max: 1 });
  try {
    return await withTenantTransaction(pool, { userId, workspaceId }, async (tx) => {
      return await fn(tx);
    });
  } finally {
    await pool.end();
  }
}

/** Transaction with ONLY app.user_id set (bootstrap-style narrower context). */
export async function withUserContext<T>(
  userId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectAs("app_user");
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Transaction with app.user_id AND app.workspace_id set on a raw client. */
export async function withWorkspaceContext<T>(
  userId: string,
  workspaceId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectAs("app_user");
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [userId, workspaceId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** Calls a security-definer function as app_user with NO tenant context. */
export async function callFunction(
  sql: string,
  params: unknown[],
): Promise<unknown> {
  const client = await connectAs("app_user");
  try {
    const res = await client.query(sql, params);
    return res.rows[0] ? Object.values(res.rows[0])[0] : undefined;
  } finally {
    await client.end();
  }
}

export const TEST_SCHEMA = {
  schemaVersion: 1,
  title: "Seeded form",
  blocks: [
    { id: "blockwelcome1", kind: "welcome", title: "Hello" },
    {
      id: "blockquestion1",
      kind: "short_text",
      label: "What is your name?",
      required: true,
    },
    { id: "blockending01", kind: "ending", title: "Thanks!" },
  ],
  logic: [],
  theme: { preset: "default" },
  settings: {},
} as const;
