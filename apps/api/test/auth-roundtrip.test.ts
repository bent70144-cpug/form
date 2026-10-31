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
import { loadApiEnv } from "../src/env";
import { getAuthTablesDdlOwner, AUTH_SCHEMA } from "./helpers";

/**
 * Ticket 02 spike — Better Auth mount round-trip against real Postgres:
 * sign-up → sign-in → Set-Cookie → session fetch, all through the NestJS
 * mount at `/v1/auth/*` with Better Auth tables living in the non-public
 * `auth` schema.
 *
 * Ticket 03 note: sign-up no longer creates a session (enumeration-safe
 * duplicate handling + explicit sign-in); the round trip now signs in before
 * fetching the session. Full auth-core coverage lives in auth-core.test.ts.
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
    loadApiEnv({
      PORT: "4000",
      DATABASE_URL: urls.appUserUrl,
      APP_ORIGIN,
      BETTER_AUTH_SECRET: "spike-test-secret-0123456789",
      NODE_ENV: "test",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "1025",
    }),
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

  it("completes a sign-up → sign-in → Set-Cookie → session round trip", async () => {
    const signUp = await request(expressApp)
      .post("/v1/auth/sign-up/email")
      .set("Origin", APP_ORIGIN)
      .send({ name: "Spike User", email: RUN_EMAIL, password: "spike-password-123" });
    expect(signUp.status).toBe(200);
    // Enumeration-safe signup creates NO session cookie (sign-in is explicit).
    expect(signUp.headers["set-cookie"]).toBeUndefined();

    const signIn = await request(expressApp)
      .post("/v1/auth/sign-in/email")
      .set("Origin", APP_ORIGIN)
      .send({ email: RUN_EMAIL, password: "spike-password-123" });
    expect(signIn.status).toBe(200);
    const setCookie = signIn.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookie = (setCookie as unknown as string[]).map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("better-auth.session_token=");

    const session = await request(expressApp)
      .get("/v1/auth/get-session")
      .set("Cookie", cookie);
    expect(session.status).toBe(200);
    const sessionBody = session.body as { user: { id: string; email: string }; session: unknown };
    expect(sessionBody.user.email).toBe(RUN_EMAIL);
    // UUID decision (ADR 0002/0003): user IDs are UUIDs via generateId.
    expect(isUuid(sessionBody.user.id)).toBe(true);
    expect(sessionBody.session).toBeTruthy();
  });

  it("serves the minimal Nest session endpoint for a signed-in session", async () => {
    const signIn = await request(expressApp)
      .post("/v1/auth/sign-in/email")
      .set("Origin", APP_ORIGIN)
      .send({ email: RUN_EMAIL, password: "spike-password-123" });
    const cookie = (signIn.headers["set-cookie"] as unknown as string[])
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await request(expressApp).get("/v1/auth/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: expect.any(String),
      email: RUN_EMAIL,
      emailVerified: false,
      workspace: null,
    });
    // Unverified user on a guarded route → 403 email_unverified (probe route).
    const probe = await request(expressApp)
      .get("/v1/probe/verified")
      .set("Cookie", cookie);
    expect(probe.status).toBe(403);
    expect(probe.body).toMatchObject({ code: "email_unverified", status: 403 });
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
