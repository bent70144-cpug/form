import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { emptyDraft } from "@form/form-schema";
import { createFormResponseSchema, type FormDetail } from "@form/contracts";
import { en } from "@form/i18n";
import { createPool, withTenantTransaction } from "@form/database";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 06 API slice — forms in the active workspace, end-to-end over the
 * real HTTP stack (supertest against createApiApp, embedded Postgres, REAL
 * roles):
 *
 *   POST   /v1/forms           — 201 form + draft (empty envelope, version 0),
 *                                `form.created` audit row + outbox event in
 *                                the SAME transaction; default project found
 *                                via `projects.is_default` (name-independent);
 *   GET    /v1/forms           — cursor pagination (default 20, max 100),
 *                                newest first by (created_at, id);
 *   GET    /v1/forms/{id}      — form + draft; unknown/cross-workspace → 404;
 *   PATCH  /v1/forms/{id}      — renames the DASHBOARD label only (the draft
 *                                envelope's respondent-facing title is
 *                                untouched); unknown/cross-workspace → 404;
 *   tenancy: cross-workspace access is 404 (never 403) and app_user cannot
 *   read another workspace's forms directly (RLS).
 */

const SCRATCH_DB = "t06_forms_api";
let fx: AuthCoreFixture;
let app: Express;

let userSeq = 0;

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
    .send({ name: "Forms User", email, password, callbackURL: "/dashboard" });
  expect(res.status).toBe(200);
  return res;
}

async function signIn(email: string, password = "correct-horse-12"): Promise<string> {
  const res = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password });
  expect(res.status).toBe(200);
  return cookieHeaderOf(res.headers["set-cookie"]);
}

/** Signs up (unique email), verifies via the mail sink, signs in. */
async function newVerifiedUser(prefix: string): Promise<{ email: string; cookie: string }> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t06.example`;
  await signUp(email);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
  const cookie = await signIn(email);
  return { email, cookie };
}

/** A verified user WITH a bootstrapped personal workspace. */
async function newWorkspaceUser(
  prefix: string,
): Promise<{ email: string; cookie: string; workspaceId: string }> {
  const { email, cookie } = await newVerifiedUser(prefix);
  const workspaceId = await bootstrapWorkspace(cookie);
  return { email, cookie, workspaceId };
}

/** Signs in WITHOUT verifying (the 403 email_unverified boundary). */
async function newUnverifiedUser(prefix: string): Promise<string> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t06.example`;
  await signUp(email);
  return signIn(email);
}

async function bootstrapWorkspace(cookie: string): Promise<string> {
  const res = await request(app)
    .post("/v1/workspaces/bootstrap")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(res.status).toBe(200);
  return res.body.workspace.id as string;
}

function createForm(cookie: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send(body);
}

function listForms(cookie: string, query = "") {
  return request(app).get(`/v1/forms${query}`).set("Cookie", cookie);
}

function getForm(cookie: string, formId: string) {
  return request(app).get(`/v1/forms/${formId}`).set("Cookie", cookie);
}

function renameForm(cookie: string, formId: string, body: Record<string, unknown>, origin = fx.appName) {
  const req = request(app)
    .patch(`/v1/forms/${formId}`)
    .set("Cookie", cookie);
  if (origin !== undefined) req.set("Origin", origin);
  return req.send(body);
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("POST /v1/forms (create)", () => {
  it("creates a form + draft (version 0, exact empty envelope) and returns the detail", async () => {
    const { cookie } = await newWorkspaceUser("forms-a");
    const res = await createForm(cookie, {});
    expect(res.status).toBe(201);
    expect(createFormResponseSchema.safeParse(res.body).success).toBe(true);

    const detail = res.body as FormDetail;
    expect(detail.name).toBe(en.dashboard.forms.untitled);
    expect(detail.status).toBe("draft");
    expect(detail.draft.draftVersion).toBe(0);
    // The empty envelope is EXACTLY this (spec, form schema + versioning).
    expect(detail.draft.schema).toEqual(emptyDraft());

    // The default project is a real project of the workspace (by flag).
    const session = await request(app).get("/v1/auth/session").set("Cookie", cookie);
    const workspaceId = session.body.workspace.id as string;
    const projects = await fx.adminClient.query<{
      id: string;
      is_default: boolean;
      name: string;
    }>(
      `SELECT id::text, is_default, name FROM app.projects WHERE workspace_id = $1`,
      [workspaceId],
    );
    const flagged = projects.rows.filter((p) => p.is_default);
    expect(flagged).toHaveLength(1);
    expect(detail.projectId).toBe(flagged[0]!.id);
  });

  it("persists the draft row (version 0) and wires the circular current_draft_id pointer", async () => {
    const { cookie } = await newWorkspaceUser("forms-b");
    const created = await createForm(cookie, {});
    const detail = created.body as FormDetail;

    const draft = await fx.adminClient.query<{
      draft_version: number;
      schema: unknown;
      current_draft_id: string | null;
      n: string;
    }>(
      `SELECT d.draft_version, d."schema" AS schema,
              (SELECT current_draft_id::text FROM app.forms f
                WHERE f.workspace_id = d.workspace_id AND f.id = d.form_id) AS current_draft_id,
              (SELECT count(*)::text FROM app.form_drafts x
                WHERE x.workspace_id = d.workspace_id AND x.form_id = d.form_id) AS n
         FROM app.form_drafts d
        WHERE d.form_id = $1`,
      [detail.id],
    );
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]!.draft_version).toBe(0);
    expect(draft.rows[0]!.n).toBe("1");
    expect(draft.rows[0]!.schema).toEqual(emptyDraft());
    expect(draft.rows[0]!.current_draft_id).not.toBeNull();
  });

  it("writes the form.created audit row and outbox event in the same transaction", async () => {
    const { cookie } = await newWorkspaceUser("forms-c");
    const created = await createForm(cookie, {});
    const detail = created.body as FormDetail;

    const audit = await fx.adminClient.query<{
      action: string;
      actor: string | null;
      target_type: string | null;
      target_id: string | null;
    }>(
      `SELECT action, actor::text, target_type, target_id
         FROM app.audit_logs WHERE target_id = $1 AND action = 'form.created'`,
      [detail.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_type).toBe("form");

    const outbox = await fx.adminClient.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM app.outbox_events
        WHERE event_type = 'form.created' AND payload->>'formId' = $1`,
      [detail.id],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.payload.formId).toBe(detail.id);
    expect(typeof outbox.rows[0]!.payload.workspaceId).toBe("string");
    expect(typeof outbox.rows[0]!.payload.userId).toBe("string");
  });

  it("finds the default project by FLAG, not by name (renamed default project wins)", async () => {
    const { email, cookie } = await newVerifiedUser("forms-flag");
    const wsId = await bootstrapWorkspace(cookie);
    const userId = await fx.adminClient.query<{ id: string }>(
      `SELECT id::text FROM auth."user" WHERE email = $1`,
      [email],
    );

    // Prove name-independence: rename the flagged project to something that
    // is NOT "General" and add a SECOND project whose NAME is "General" but
    // which is NOT flagged. Fixture writes run as app_user INSIDE a tenant
    // transaction (RLS both-clauses still apply).
    const pool = createPool(fx.urls.appUserUrl, { max: 2 });
    try {
      await withTenantTransaction(
        pool,
        { userId: userId.rows[0]!.id, workspaceId: wsId },
        async (tx) => {
          await tx.query(
            `UPDATE app.projects SET name = 'Home Base'
              WHERE workspace_id = $1 AND is_default AND deleted_at IS NULL`,
            [wsId],
          );
          await tx.query(
            `INSERT INTO app.projects (id, workspace_id, name, is_default)
             VALUES (gen_random_uuid(), $1, 'General', false)`,
            [wsId],
          );
        },
      );
    } finally {
      await pool.end();
    }

    const res = await createForm(cookie, {});
    expect(res.status).toBe(201);
    const detail = res.body as FormDetail;
    const flagged = await fx.adminClient.query<{ id: string }>(
      `SELECT id::text FROM app.projects WHERE workspace_id = $1 AND is_default`,
      [wsId],
    );
    expect(flagged.rows).toHaveLength(1);
    // Landed under the FLAGGED project (renamed), never the name match.
    expect(detail.projectId).toBe(flagged.rows[0]!.id);
  });

  it("requires a verified email and the same-origin Origin header", async () => {
    // Unverified: signed up, never verified.
    const unverified = await newUnverifiedUser("forms-unv");
    const resUnverified = await createForm(unverified, {});
    expect(resUnverified.status).toBe(403);
    expect(resUnverified.body.code).toBe("email_unverified");

    // Signed-out.
    const resAnon = await request(app).post("/v1/forms").set("Origin", fx.appName).send({});
    expect(resAnon.status).toBe(401);
    expect(resAnon.body.code).toBe("unauthenticated");

    // Origin mismatch on the state-changing POST.
    const { cookie } = await newWorkspaceUser("forms-origin");
    const noOrigin = await request(app)
      .post("/v1/forms")
      .set("Cookie", cookie)
      .send({});
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe("origin_mismatch");
  });

  it("rejects invalid bodies with 422 validation_failed", async () => {
    const { cookie } = await newWorkspaceUser("forms-invalid");
    const res = await createForm(cookie, { name: "" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("validation_failed");
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const long = await createForm(cookie, { name: "x".repeat(201) });
    expect(long.status).toBe(422);
    const junk = await createForm(cookie, { projectId: "nope" });
    expect(junk.status).toBe(422);
  });
});

describe("GET /v1/forms (list)", () => {
  it("paginates newest first with an opaque cursor (default 20, max 100)", async () => {
    const { cookie } = await newWorkspaceUser("forms-list");

    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await createForm(cookie, { name: `Form ${i}` });
      expect(res.status).toBe(201);
      created.push((res.body as FormDetail).id);
      // Distinct created_at timestamps → deterministic (created_at, id) order.
      await new Promise((r) => setTimeout(r, 15));
    }

    const page1 = await listForms(cookie, "?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.forms.map((f: { id: string }) => f.id)).toEqual([
      created[4],
      created[3],
    ]);
    expect(typeof page1.body.nextCursor).toBe("string");

    const page2 = await listForms(
      cookie,
      `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.forms.map((f: { id: string }) => f.id)).toEqual([
      created[2],
      created[1],
    ]);
    expect(typeof page2.body.nextCursor).toBe("string");

    const page3 = await listForms(
      cookie,
      `?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`,
    );
    expect(page3.body.forms.map((f: { id: string }) => f.id)).toEqual([created[0]]);
    expect(page3.body.nextCursor).toBeNull();
  });

  it("serves a default 20-item page from 25 forms, cursor yields the rest", async () => {
    const { cookie } = await newWorkspaceUser("forms-25");
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await createForm(cookie, { name: `Bulk ${i}` });
      expect(res.status).toBe(201);
      ids.push((res.body as FormDetail).id);
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listForms(cookie);
    expect(page1.status).toBe(200);
    expect(page1.body.forms).toHaveLength(20);
    expect(typeof page1.body.nextCursor).toBe("string");
    const page1Ids = (page1.body.forms as Array<{ id: string }>).map((f) => f.id);
    expect(page1Ids[0]).toBe(ids[ids.length - 1]); // newest first

    const page2 = await listForms(
      cookie,
      `?cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.forms).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();
    const page2Ids = (page2.body.forms as Array<{ id: string }>).map((f) => f.id);
    expect(page2Ids[page2Ids.length - 1]).toBe(ids[0]); // oldest last
    expect(page2Ids.some((id) => page1Ids.includes(id))).toBe(false);
  });

  it("defaults the page size to 20 and validates the limit bounds", async () => {
    const { cookie } = await newWorkspaceUser("forms-def");
    for (let i = 0; i < 3; i += 1) await createForm(cookie, {});

    const page = await listForms(cookie);
    expect(page.status).toBe(200);
    expect(page.body.forms).toHaveLength(3);
    expect(page.body.nextCursor).toBeNull();

    const zero = await listForms(cookie, "?limit=0");
    expect(zero.status).toBe(422);
    expect(zero.body.code).toBe("validation_failed");
    const over = await listForms(cookie, "?limit=101");
    expect(over.status).toBe(422);
    const badCursor = await listForms(cookie, "?cursor=%%%garbage");
    expect(badCursor.status).toBe(422);
  });
});

describe("GET /v1/forms/{id} + PATCH /v1/forms/{id}", () => {
  it("reads the form with its draft", async () => {
    const { cookie } = await newWorkspaceUser("forms-read");
    const created = await createForm(cookie, { name: "Intake" });
    const detail = created.body as FormDetail;

    const res = await getForm(cookie, detail.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: detail.id,
      name: "Intake",
      status: "draft",
      projectId: detail.projectId,
    });
    expect(res.body.draft.draftVersion).toBe(0);
    expect(res.body.draft.schema).toEqual(emptyDraft());
  });

  it("renames the DASHBOARD label only — the envelope title stays empty", async () => {
    const { cookie } = await newWorkspaceUser("forms-rename");
    const created = await createForm(cookie, {});
    const detail = created.body as FormDetail;

    const res = await renameForm(cookie, detail.id, { name: "Client intake" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: detail.id, name: "Client intake" });

    // The list shows the new label; the draft schema title is untouched.
    const list = await listForms(cookie);
    const row = list.body.forms.find((f: { id: string }) => f.id === detail.id);
    expect(row?.name).toBe("Client intake");

    const read = await getForm(cookie, detail.id);
    expect(read.body.name).toBe("Client intake");
    // The respondent-facing title lives in the envelope (builder, T08).
    expect(read.body.draft.schema.title).toBe("");

    const after = await fx.adminClient.query<{ schema: { title?: string } }>(
      `SELECT "schema" FROM app.form_drafts WHERE form_id = $1`,
      [detail.id],
    );
    expect(after.rows[0]!.schema.title).toBe("");
  });

  it("rejects a PATCH without an Origin header (state-changing)", async () => {
    const { cookie } = await newWorkspaceUser("forms-patch-origin");
    const detail = (await createForm(cookie, {})).body as FormDetail;
    // Inline (no helper default): the request carries NO Origin header.
    const res = await request(app)
      .patch(`/v1/forms/${detail.id}`)
      .set("Cookie", cookie)
      .send({ name: "No origin" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("origin_mismatch");
  });

  it("validates rename bodies with 422", async () => {
    const { cookie } = await newWorkspaceUser("forms-renv");
    const detail = (await createForm(cookie, {})).body as FormDetail;
    const empty = await renameForm(cookie, detail.id, { name: "" });
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe("validation_failed");
    const long = await renameForm(cookie, detail.id, { name: "x".repeat(201) });
    expect(long.status).toBe(422);
    const missing = await renameForm(cookie, detail.id, {});
    expect(missing.status).toBe(422);
  });

  it("answers 404 (never 403) for unknown ids and non-UUID path params", async () => {
    const { cookie } = await newWorkspaceUser("forms-404");
    const unknownId = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b";
    const read = await getForm(cookie, unknownId);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe("not_found");
    const junk = await getForm(cookie, "not-a-uuid");
    expect(junk.status).toBe(404);
    const rename = await renameForm(cookie, "also-not-a-uuid", { name: "x" });
    expect(rename.status).toBe(404);
  });
});

describe("tenancy: cross-workspace access is 404 and RLS holds", () => {
  it("never exposes another workspace's forms (404 + direct RLS denial)", async () => {
    // User A creates a form.
    const { cookie: cookieA, workspaceId: wsA } = await newWorkspaceUser("forms-ten-a");
    const formA = (await createForm(cookieA, { name: "A only" })).body as FormDetail;

    // User B (own workspace via create_personal_workspace) cannot see or
    // rename it — 404, indistinguishable from a missing row.
    const { email: emailB, cookie: cookieB } = await newWorkspaceUser("forms-ten-b");
    const ownB = (await createForm(cookieB, { name: "B only" })).body as FormDetail;
    const read = await getForm(cookieB, formA.id);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe("not_found");
    const rename = await renameForm(cookieB, formA.id, { name: "hijack" });
    expect(rename.status).toBe(404);
    const list = await listForms(cookieB);
    expect(list.body.forms.map((f: { id: string }) => f.id)).not.toContain(formA.id);

    // And the RLS guarantee directly: app_user in B's OWN workspace context
    // cannot read A's form row (the USING clause hides it → zero rows), while
    // B still sees its own forms through the same role/policy.
    const userIdB = await fx.adminClient.query<{ id: string }>(
      `SELECT id::text FROM auth."user" WHERE email = $1`,
      [emailB],
    );
    const wsB = (
      await fx.adminClient.query<{ id: string }>(
        `SELECT w.id::text FROM app.workspaces w
          JOIN auth."user" u ON u.id::text = w.creator::text
         WHERE u.email = $1 AND w.is_personal`,
        [emailB],
      )
    ).rows[0]!.id;
    const pool = createPool(fx.urls.appUserUrl, { max: 1 });
    try {
      await withTenantTransaction(
        pool,
        { userId: userIdB.rows[0]!.id, workspaceId: wsB },
        async (tx) => {
          const res = await tx.query<{ id: string }>(
            `SELECT id::text FROM app.forms WHERE id = $1`,
            [formA.id],
          );
          expect(res.rows).toHaveLength(0);
          // RLS USING also shields writes: A's row does not match → 0 updates.
          const stolen = await tx.query<{ id: string }>(
            `UPDATE app.forms SET name = 'stolen' WHERE id = $1 RETURNING id::text`,
            [formA.id],
          );
          expect(stolen.rows).toHaveLength(0);
          // B's own form is visible through the same role/policy.
          const own = await tx.query<{ id: string }>(
            `SELECT id::text FROM app.forms WHERE id = $1`,
            [ownB.id],
          );
          expect(own.rows).toHaveLength(1);
          // WITH CHECK rejects a row for ANOTHER workspace outright: the
          // form_drafts parent (A's workspace, A's form) EXISTS, so the only
          // possible rejection is the policy — not a foreign key.
          await expect(
            tx.query(
              `INSERT INTO app.form_drafts (id, workspace_id, form_id, schema)
               VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb)`,
              [wsA, formA.id],
            ),
          ).rejects.toThrow(/row-level security/);
        },
      );
    } finally {
      await pool.end();
    }
  });
});
