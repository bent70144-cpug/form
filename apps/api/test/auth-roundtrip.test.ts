import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Kysely, PostgresDialect } from "kysely";
import { Client, Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { isUuid } from "@form/database";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  type BootstrappedUrls,
} from "@form/database/testing";
import { createApiApp } from "../src/app";
import { getAuthTablesDdlOwner, AUTH_SCHEMA } from "./helpers";

/**
 * Ticket 02 spike — Better Auth mount round-trip against real Postgres:
 * sign-up → Set-Cookie → session fetch, all through the NestJS mount at
 * `/v1/auth/*` with Better Auth tables living in the non-public `auth` schema.
 *
 * The `auth` schema tables are created by Better Auth itself (its compiled
 * Kysely DDL, executed here as the ADMIN as a migrator-adjacent test step).
 * In production the migrator owns these tables (the compiled DDL lands in a
 * migration file) — recorded in docs/adr/0003-topology-spike.md.
 */

const SCRATCH_DB = "t02_auth_spike";
const APP_ORIGIN = "http://localhost:3000";

let urls: BootstrappedUrls;
let adminClient: Client;
let authPool: Pool;
let expressApp: Awaited<ReturnType<typeof createApiApp>>["expressApp"];
const RUN_EMAIL = `spike-${Date.now()}@example.com`;

beforeAll(async () => {
  await createScratchDatabase(SCRATCH_DB);
  urls = await ensureBootstrapped(SCRATCH_DB);
  adminClient = new Client({ connectionString: urls.adminUrl });
  await adminClient.connect();

  // 1. Let Better Auth create its tables in the `auth` schema (admin step).
  //    `database: { db, type: "postgres", schemaName: "auth" }` makes the
  //    compiled DDL schema-qualified — verified against better-auth 1.7.14.
  const pool = new Pool({ connectionString: urls.adminUrl, max: 1 });
  const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const { runMigrations } = await getMigrations(
    {
      database: { db: kysely, type: "postgres", schemaName: AUTH_SCHEMA },
      plugins: [],
      rateLimit: { enabled: false },
    } as never,
    { throwOnUnsafe: false },
  );
  await runMigrations();
  await kysely.destroy(); // destroys the pool it was built on

  // 2. Runtime DML grants for app_user (admin step; migrations own this in
  //    production). No CREATE — the runtime role stays DML-only.
  for (const sql of [
    `GRANT USAGE ON SCHEMA ${AUTH_SCHEMA} TO app_user`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${AUTH_SCHEMA} TO app_user`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${AUTH_SCHEMA} TO app_user`,
  ]) {
    await adminClient.query(sql);
  }

  // 3. Runtime app under the app_user role (pooled URL path of the topology).
  authPool = new Pool({ connectionString: urls.appUserUrl, max: 5 });
  const app = await createApiApp(
    {
      PORT: 4000,
      DATABASE_URL: urls.appUserUrl,
      APP_ORIGIN,
      BETTER_AUTH_SECRET: "spike-test-secret-0123456789",
      NODE_ENV: "test",
    },
    { authPool },
  );
  expressApp = app.expressApp;
}, 120_000);

afterAll(async () => {
  await authPool?.end().catch(() => undefined);
  await adminClient?.end();
  await dropDatabase(SCRATCH_DB);
});

describe("Better Auth mounted under /v1/auth (NestJS)", () => {
  it("created the auth tables in the non-public auth schema owned by migrator", async () => {
    const res = await adminClient.query<{ table_name: string; table_owner: string }>(
      `SELECT tablename AS table_name, tableowner AS table_owner FROM pg_tables
       WHERE schemaname = $1 ORDER BY tablename`,
      [AUTH_SCHEMA],
    );
    const names = res.rows.map((r) => r.table_name).sort();
    expect(names).toEqual(["account", "session", "user", "verification"]);
    expect(res.rows.every((r) => r.table_owner === "migrator" || r.table_owner === "postgres")).toBe(true);
  });

  it("completes a sign-up → Set-Cookie → session round trip", async () => {
    const signUp = await request(expressApp)
      .post("/v1/auth/sign-up/email")
      .set("Origin", APP_ORIGIN)
      .send({ name: "Spike User", email: RUN_EMAIL, password: "spike-password-123" });
    expect(signUp.status).toBe(200);

    const setCookie = signUp.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookie = (setCookie as unknown as string[]).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("better-auth.session_token=");

    const body = signUp.body as { user?: { id: string; email: string } };
    expect(body.user?.email).toBe(RUN_EMAIL);
    // UUID decision (ADR 0002/0003): user IDs are UUIDs via generateId.
    expect(isUuid(body.user!.id)).toBe(true);

    const session = await request(expressApp)
      .get("/v1/auth/get-session")
      .set("Cookie", cookie);
    expect(session.status).toBe(200);
    const sessionBody = session.body as { user: { id: string; email: string }; session: unknown };
    expect(sessionBody.user.email).toBe(RUN_EMAIL);
    expect(sessionBody.user.id).toBe(body.user!.id);
    expect(sessionBody.session).toBeTruthy();
  });

  it("records what Nest sees as the peer address and forwarded headers (spike hop)", async () => {
    const res = await request(expressApp).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
    // Direct (in-process) hop: the peer is loopback. Through the Next.js
    // rewrite the peer is the Next process — see the ADR curl runbook.
    expect(res.headers["x-spike-peer-address"]).toMatch(/127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  });

  it("keeps app_user DML-only in the auth schema (no CREATE)", async () => {
    await expect(
      adminClient.query(`SET ROLE app_user; CREATE TABLE ${AUTH_SCHEMA}.rogue (id int); RESET ROLE;`),
    ).rejects.toHaveProperty("code", "42501");
  });
});

// Referenced in the ADR: which role owns the auth tables after the spike step.
export async function authTableOwner() {
  return getAuthTablesDdlOwner(adminClient);
}
