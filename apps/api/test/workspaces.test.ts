import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { isUuid } from "@form/database";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 05 — workspace bootstrap, session workspace, and the tenant request
 * contexts, end-to-end against real Postgres + the embedded fixture:
 *
 *   - POST /v1/workspaces/bootstrap: verified-email 200 + workspace shape;
 *     idempotent (same workspace, no duplicate workspace/membership/project/
 *     audit/outbox rows); 403 `email_unverified` before verification;
 *     401 unauthenticated; the global Origin guard applies (no internal
 *     exemption — a server-component call without Origin is rejected).
 *   - GET /v1/auth/session: workspace null before bootstrap (and repeated
 *     reads never create one), {id,name,role} after.
 *   - FULL workspace context (GET /v1/probe/workspace): interceptor resolves
 *     the workspace via list_workspaces(), sets app.workspace_id
 *     transaction-locally, and keeps users isolated; 403 `forbidden` before
 *     bootstrap; unverified users get 403 `email_unverified`.
 *   - Audit foundation: exactly one `workspace.created` audit row after the
 *     first bootstrap, no duplicate after repeats.
 */

const SCRATCH_DB = "t05_workspaces";
let fx: AuthCoreFixture;
let app: Express;

let VERIFIED_EMAIL: string;
let VERIFIED_COOKIES = "";
let VERIFIED_USER_ID = "";

let UNVERIFIED_EMAIL = "";

async function signUp(
  body: Record<string, unknown>,
  origin: string | undefined = fx.appName,
) {
  const req = request(app).post("/v1/auth/sign-up/email");
  if (origin) req.set("Origin", origin);
  return req.send(body);
}

async function waitForMailTo(to: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await fx.mailbox();
    const found = messages.find((m) => m.to.some((t) => t.includes(to)));
    if (found) return found.raw;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail delivered to ${to} within ${timeoutMs}ms`);
}

/** Signs up, verifies via the sink's link, and returns the session cookies. */
async function signUpAndVerify(email: string): Promise<string> {
  const res = await signUp({ name: "T05 User", email, password: "password-12-chars-min" });
  expect(res.status).toBe(200);
  const raw = await waitForMailTo(email);
  const url = extractVerificationUrl(raw);
  const target = new URL(url);
  const verified = await request(app).get(`${target.pathname}${target.search}`);
  expect([200, 302]).toContain(verified.status);

  const signIn = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password: "password-12-chars-min" });
  expect(signIn.status).toBe(200);
  return cookieHeaderOf(signIn.headers["set-cookie"]);
}

async function bootstrap(origin: string | undefined = fx.appName) {
  const req = request(app).post("/v1/workspaces/bootstrap");
  if (origin) req.set("Origin", origin);
  if (VERIFIED_COOKIES) req.set("Cookie", VERIFIED_COOKIES);
  return req.send();
}

async function session() {
  return request(app).get("/v1/auth/session").set("Cookie", VERIFIED_COOKIES);
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;

  VERIFIED_EMAIL = `verified-${Date.now()}@t05.example`;
  UNVERIFIED_EMAIL = `unverified-${Date.now()}@t05.example`;
  VERIFIED_COOKIES = await signUpAndVerify(VERIFIED_EMAIL);
  const userId = await fx.adminClient.query<{ id: string }>(
    `SELECT id::text FROM auth."user" WHERE email = $1`,
    [VERIFIED_EMAIL],
  );
  VERIFIED_USER_ID = userId.rows[0]!.id;

  // A signed-in but UNVERIFIED account (no mailbox round-trip).
  const res = await signUp({ name: "T05 Unverified", email: UNVERIFIED_EMAIL, password: "password-12-chars-min" });
  expect(res.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

describe("POST /v1/workspaces/bootstrap", () => {
  it("creates the personal workspace for a verified user (owner role)", async () => {
    const res = await bootstrap();
    expect(res.status).toBe(200);
    const workspace = res.body.workspace;
    expect(isUuid(workspace.id)).toBe(true);
    expect(workspace.name).toBe("Personal Workspace");
    expect(workspace.role).toBe("owner");
  });

  it("is idempotent: same workspace, no duplicate workspace/membership/project/audit/outbox rows", async () => {
    const first = await bootstrap();
    const second = await bootstrap();
    expect(second.status).toBe(200);
    expect(second.body.workspace.id).toBe(first.body.workspace.id);

    const counts = await fx.adminClient.query<{
      workspaces: string;
      members: string;
      projects: string;
      audit: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*) FROM app.workspaces WHERE creator = $1)::text AS workspaces,
         (SELECT count(*) FROM app.workspace_members WHERE user_id = $1)::text AS members,
         (SELECT count(*) FROM app.projects p JOIN app.workspaces w ON w.id = p.workspace_id
            WHERE w.creator = $1 AND p.is_default)::text AS projects,
         (SELECT count(*) FROM app.audit_logs a JOIN app.workspaces w ON w.id = a.workspace_id
            WHERE w.creator = $1 AND a.action = 'workspace.created')::text AS audit,
         (SELECT count(*) FROM app.outbox_events e WHERE (e.payload->>'userId')::uuid = $1
            AND e.event_type = 'workspace.created')::text AS outbox`,
      [VERIFIED_USER_ID],
    );
    expect(counts.rows[0]).toEqual({
      workspaces: "1",
      members: "1",
      projects: "1",
      audit: "1",
      outbox: "1",
    });
  });

  it("rejects unverified users with 403 email_unverified", async () => {
    const signIn = await request(app)
      .post("/v1/auth/sign-in/email")
      .set("Origin", fx.appName)
      .send({ email: UNVERIFIED_EMAIL, password: "password-12-chars-min" });
    expect(signIn.status).toBe(200);
    const cookies = cookieHeaderOf(signIn.headers["set-cookie"]);
    const res = await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Origin", fx.appName)
      .set("Cookie", cookies)
      .send();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("email_unverified");
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
  it("rejects signed-out requests with 401", async () => {
    const res = await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Origin", fx.appName)
      .send();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });

  it("passes the global Origin guard (no internal-call exemption)", async () => {
    const missing = await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Cookie", VERIFIED_COOKIES)
      .send();
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe("origin_mismatch");

    const mismatched = await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Origin", "https://evil.example")
      .set("Cookie", VERIFIED_COOKIES)
      .send();
    expect(mismatched.status).toBe(403);
    expect(mismatched.body.code).toBe("origin_mismatch");
  });
});

describe("GET /v1/auth/session (active workspace)", () => {
  it("returns workspace null BEFORE bootstrap and never creates one while reading", async () => {
    // Fresh user: sign up + verify, then read the session WITHOUT bootstrapping.
    const email = `session-null-${Date.now()}@t05.example`;
    const cookies = await signUpAndVerify(email);
    const before = await request(app).get("/v1/auth/session").set("Cookie", cookies);
    expect(before.status).toBe(200);
    expect(before.body.workspace).toBeNull();

    // Repeat reads: still null, still no workspace created.
    const again = await request(app).get("/v1/auth/session").set("Cookie", cookies);
    expect(again.body.workspace).toBeNull();
    const created = await fx.adminClient.query<{ count: string }>(
      `SELECT count(*)::text FROM app.workspaces w
        JOIN auth."user" u ON u.id::text = w.creator::text WHERE u.email = $1`,
      [email],
    );
    expect(created.rows[0]!.count).toBe("0");
  });

  it("returns {id, name, role} after bootstrap and stays read-only", async () => {
    const res = await session();
    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({
      name: "Personal Workspace",
      role: "owner",
    });
    expect(isUuid(res.body.workspace.id)).toBe(true);
    expect(res.body.workspace.id).toBe(
      (await bootstrap()).body.workspace.id,
    );
  });

  it("answers 401 with an empty body for signed-out visitors", async () => {
    const res = await request(app).get("/v1/auth/session");
    expect(res.status).toBe(401);
    expect(res.text).toBe("");
  });
});

describe("FULL workspace request context (GET /v1/probe/workspace)", () => {
  it("403 forbidden before bootstrap (nothing to activate)", async () => {
    const email = `probe-early-${Date.now()}@t05.example`;
    const cookies = await signUpAndVerify(email);
    const res = await request(app)
      .get("/v1/probe/workspace")
      .set("Cookie", cookies);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("resolves the active workspace and sets app.workspace_id transaction-locally", async () => {
    const ws = (await bootstrap()).body.workspace;
    const res = await request(app)
      .get("/v1/probe/workspace")
      .set("Cookie", VERIFIED_COOKIES);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      via: "workspace-context",
      userId: VERIFIED_USER_ID,
      workspaceId: ws.id,
      // Re-read from the DB session INSIDE the transaction: the setting is real.
      workspaceSetting: ws.id,
    });
  });

  it("keeps users isolated: each caller sees only its own workspace", async () => {
    const email = `probe-other-${Date.now()}@t05.example`;
    const cookies = await signUpAndVerify(email);
    await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Origin", fx.appName)
      .set("Cookie", cookies)
      .send();

    const other = await request(app)
      .get("/v1/probe/workspace")
      .set("Cookie", cookies);
    expect(other.status).toBe(200);
    expect(other.body.userId).not.toBe(VERIFIED_USER_ID);
    expect(other.body.workspaceId).not.toBe(
      (await bootstrap()).body.workspace.id,
    );
    expect(other.body.workspaceSetting).toBe(other.body.workspaceId);
  });

  it("rejects unverified users with 403 email_unverified (guard runs first)", async () => {
    const signIn = await request(app)
      .post("/v1/auth/sign-in/email")
      .set("Origin", fx.appName)
      .send({ email: UNVERIFIED_EMAIL, password: "password-12-chars-min" });
    const cookies = cookieHeaderOf(signIn.headers["set-cookie"]);
    const res = await request(app)
      .get("/v1/probe/workspace")
      .set("Cookie", cookies);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("email_unverified");
  });

  it("rejects signed-out requests with 401", async () => {
    const res = await request(app).get("/v1/probe/workspace");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });
});

describe("audit foundation", () => {
  it("records exactly one workspace.created audit row for the bootstrapped user", async () => {
    // bootstrap() has been called several times by now — the audit row count
    // must still be exactly 1 (repeats never duplicate it).
    const rows = await fx.adminClient.query<{
      action: string;
      workspace_id: string;
      actor: string;
      n: string;
    }>(
      `SELECT a.action, a.workspace_id::text, a.actor::text, count(*) OVER ()::text AS n
         FROM app.audit_logs a
         JOIN app.workspaces w ON w.id = a.workspace_id
        WHERE w.creator = $1 AND a.action = 'workspace.created'`,
      [VERIFIED_USER_ID],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      action: "workspace.created",
      actor: VERIFIED_USER_ID,
      workspace_id: (await bootstrap()).body.workspace.id,
    });
  });
});
