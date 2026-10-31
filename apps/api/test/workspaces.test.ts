import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  bootstrapResponseSchema,
  problemDetailsSchema,
} from "@form/contracts";
import type { AuthSession } from "@form/auth/client";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 05 API slice — workspace bootstrap over the real HTTP stack
 * (supertest against createApiApp, embedded Postgres, REAL roles):
 *
 *   POST /v1/workspaces/bootstrap (idempotent; verified email required;
 *   Origin guard active) → security-definer create_personal_workspace() →
 *   workspace + owner membership + General project + exactly one
 *   `workspace.created` audit row and outbox event;
 *
 *   GET /v1/auth/session exposes the active workspace (read-only);
 *   the tenant request-context interceptor sets app.user_id +
 *   app.workspace_id transaction-locally (probe via current_setting);
 *   cross-tenant isolation (user B never sees user A's workspace).
 */

const SCRATCH_DB = "t05_workspaces_api";
let fx: AuthCoreFixture;
let app: Express;

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

async function signUp(email: string, password = "correct-horse-12") {
  const res = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "WS User", email, password, callbackURL: "/dashboard" });
  expect(res.status).toBe(200);
  return res;
}

/** Signs up, waits for the verification mail, follows the emailed link. */
async function signUpVerified(email: string): Promise<void> {
  await signUp(email);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
}

async function signIn(email: string, password = "correct-horse-12"): Promise<string> {
  const res = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password });
  expect(res.status).toBe(200);
  return cookieHeaderOf(res.headers["set-cookie"]);
}

function bootstrap(cookie: string, origin: string | undefined = fx.appName) {
  const req = request(app).post("/v1/workspaces/bootstrap");
  if (origin) req.set("Origin", origin);
  return req.set("Cookie", cookie);
}

/** Admin-side row counts (superuser inspection only — never request-path). */
async function countsFor(userId: string): Promise<{
  workspaces: number;
  memberships: number;
  projects: number;
  audits: number;
  outbox: number;
}> {
  const q = `
    SELECT
      (SELECT count(*)::int FROM app.workspaces WHERE creator = $1::uuid) AS workspaces,
      (SELECT count(*)::int FROM app.workspace_members WHERE user_id = $1::uuid) AS memberships,
      (SELECT count(*)::int FROM app.projects p
        JOIN app.workspaces w ON w.id = p.workspace_id
        WHERE w.creator = $1::uuid) AS projects,
      (SELECT count(*)::int FROM app.audit_logs a
        JOIN app.workspaces w ON w.id = a.workspace_id
        WHERE w.creator = $1::uuid AND a.action = 'workspace.created') AS audits,
      (SELECT count(*)::int FROM app.outbox_events e
        WHERE e.event_type = 'workspace.created'
          AND e.payload->>'userId' = $1::text) AS outbox`;
  const res = await fx.adminClient.query<{
    workspaces: number;
    memberships: number;
    projects: number;
    audits: number;
    outbox: number;
  }>(q, [userId]);
  return res.rows[0]!;
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("POST /v1/workspaces/bootstrap", () => {
  const email = `ws-a-${Date.now()}@example.com`;
  let cookie = "";
  let userId = "";
  let workspace: { id: string; name: string; role: string };

  it("rejects an UNVERIFIED user with 403 email_unverified (problem body)", async () => {
    const unverified = `ws-unverified-${Date.now()}@example.com`;
    await signUp(unverified);
    const c = await signIn(unverified);
    const res = await bootstrap(c);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe("email_unverified");
    expect(problem.status).toBe(403);
  });

  it("rejects a mutation without an Origin header — no internal-call exemption", async () => {
    await signUpVerified(email);
    cookie = await signIn(email);
    // Inline: NO Origin header at all (the bootstrap() helper defaults to the
    // app origin, and passing undefined would just trigger that default).
    const res = await request(app)
      .post("/v1/workspaces/bootstrap")
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(problemDetailsSchema.parse(res.body).code).toBe("origin_mismatch");
  });

  it("creates workspace + owner membership + General project atomically", async () => {
    const res = await bootstrap(cookie);
    expect(res.status).toBe(200);
    const parsed = bootstrapResponseSchema.parse(res.body);
    workspace = parsed.workspace;
    expect(workspace.name).toBe("Personal Workspace");
    expect(workspace.role).toBe("owner");

    const sessionRes = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", cookie);
    const session = sessionRes.body as AuthSession;
    userId = session.userId;
    expect(session.emailVerified).toBe(true);
    // Before this bootstrap ran, the session workspace was null (asserted in
    // the cross-tenant suite for user B) — here it now shows the workspace.
    expect(session.workspace).toEqual(workspace);

    const counts = await countsFor(userId);
    expect(counts).toEqual({
      workspaces: 1,
      memberships: 1,
      projects: 1,
      audits: 1,
      outbox: 1,
    });

    // Membership role + default project specifics (DB, admin inspection).
    const detail = await fx.adminClient.query<{
      role: string;
      project_name: string;
      is_default: boolean;
      is_personal: boolean;
    }>(
      `SELECT m.role, p.name AS project_name, p.is_default, w.is_personal
         FROM app.workspace_members m
         JOIN app.workspaces w ON w.id = m.workspace_id
         JOIN app.projects p ON p.workspace_id = w.id
        WHERE m.user_id = $1::uuid`,
      [userId],
    );
    const row = detail.rows[0]!;
    expect(row.role).toBe("owner");
    expect(row.is_personal).toBe(true);
    expect(row.project_name).toBe("General");
    expect(row.is_default).toBe(true);
  });

  it("is idempotent: repeated calls return the SAME workspace and never duplicate rows", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await bootstrap(cookie);
      expect(res.status).toBe(200);
      expect(bootstrapResponseSchema.parse(res.body).workspace).toEqual(workspace);
    }
    const counts = await countsFor(userId);
    expect(counts).toEqual({
      workspaces: 1,
      memberships: 1,
      projects: 1,
      audits: 1, // workspace.created audit row exists exactly once
      outbox: 1, // workspace.created outbox event exists exactly once
    });
  });
});

describe("tenant request-context interceptor (GET /v1/probe/workspace-context)", () => {
  const emailA = `ws-ctx-a-${Date.now()}@example.com`;
  let cookieA = "";
  let workspaceA: { id: string; name: string; role: string };

  it("sets app.user_id AND app.workspace_id transaction-locally for the handler", async () => {
    await signUpVerified(emailA);
    cookieA = await signIn(emailA);
    const boot = await bootstrap(cookieA);
    workspaceA = bootstrapResponseSchema.parse(boot.body).workspace;

    const res = await request(app)
      .get("/v1/probe/workspace-context")
      .set("Cookie", cookieA);
    expect(res.status).toBe(200);
    const sessionRes = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", cookieA);
    const session = sessionRes.body as AuthSession;

    expect(res.body.tenant.userId).toBe(session.userId); // from the verified session
    expect(res.body.tenant.workspaceId).toBe(workspaceA.id); // resolved server-side
    expect(res.body.tenant.workspaces).toEqual([
      {
        id: workspaceA.id,
        name: workspaceA.name,
        role: "owner",
      },
    ]);
  });

  it("answers 403 forbidden with the setup detail when no workspace exists yet", async () => {
    const emailB = `ws-nobootstrap-${Date.now()}@example.com`;
    await signUpVerified(emailB);
    const cookieB = await signIn(emailB);
    const res = await request(app)
      .get("/v1/probe/workspace-context")
      .set("Cookie", cookieB);
    expect(res.status).toBe(403);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.code).toBe("forbidden");
    expect(problem.detail).toContain("/v1/workspaces/bootstrap");
  });

  it("requires a session (401) and keeps the Origin guard irrelevant for GETs", async () => {
    const res = await request(app).get("/v1/probe/workspace-context");
    expect(res.status).toBe(401);
    expect(problemDetailsSchema.parse(res.body).code).toBe("unauthenticated");
  });
});

describe("cross-tenant isolation over HTTP", () => {
  const emailA = `ws-iso-a-${Date.now()}@example.com`;
  const emailB = `ws-iso-b-${Date.now()}@example.com`;
  let cookieA = "";
  let cookieB = "";

  it("bootstraps user A; user B's session shows workspace:null (A is invisible)", async () => {
    await signUpVerified(emailA);
    cookieA = await signIn(emailA);
    const bootA = await bootstrap(cookieA);
    expect(bootA.status).toBe(200);

    await signUpVerified(emailB);
    cookieB = await signIn(emailB);

    const sessionB = await request(app)
      .get("/v1/auth/session")
      .set("Cookie", cookieB);
    expect(sessionB.status).toBe(200);
    expect((sessionB.body as AuthSession).workspace).toBeNull();
  });

  it("bootstraps user B into B's OWN workspace (a different id than A's)", async () => {
    const bootA = await bootstrap(cookieA);
    const wsA = bootstrapResponseSchema.parse(bootA.body).workspace;
    const bootB = await bootstrap(cookieB);
    expect(bootB.status).toBe(200);
    const wsB = bootstrapResponseSchema.parse(bootB.body).workspace;
    expect(wsB.id).not.toBe(wsA.id);
  });

  it("resolves each user's active workspace to their own via list_workspaces()", async () => {
    const probeA = await request(app)
      .get("/v1/probe/workspace-context")
      .set("Cookie", cookieA);
    const probeB = await request(app)
      .get("/v1/probe/workspace-context")
      .set("Cookie", cookieB);
    expect(probeA.status).toBe(200);
    expect(probeB.status).toBe(200);

    const idsA = (probeA.body.tenant.workspaces as Array<{ id: string }>).map((w) => w.id);
    const idsB = (probeB.body.tenant.workspaces as Array<{ id: string }>).map((w) => w.id);
    expect(idsA).toHaveLength(1);
    expect(idsB).toHaveLength(1);
    expect(idsB[0]).not.toBe(idsA[0]);
    expect(probeA.body.tenant.workspaceId).toBe(idsA[0]);
    expect(probeB.body.tenant.workspaceId).toBe(idsB[0]);
  });

  it("leaves pooled connections clean: no app.* settings leak after responses", async () => {
    // current_setting(..., true) on a FRESH pooled connection must be empty —
    // set_config(..., true) is transaction-local everywhere in this slice.
    const res = await fx.dbPool.query<{
      uid: string;
      wid: string;
    }>(
      "SELECT current_setting('app.user_id', true) AS uid, current_setting('app.workspace_id', true) AS wid",
    );
    expect(res.rows[0]!.uid).toBe("");
    expect(res.rows[0]!.wid).toBe("");
  });
});
