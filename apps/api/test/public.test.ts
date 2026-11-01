import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import type { FormDetail } from "@form/contracts";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 09 API slice — the UNauthenticated public render endpoint:
 *
 *   GET /v1/public/forms/{slug}
 *
 * Wraps the security-definer `get_published_form(slug)` as app_user (the
 * function crosses tenants BY DESIGN; the raw slug registry stays
 * unreadable). Spec mapping:
 *
 *   published → 200 { formId, versionId, versionNumber, schema } (immutable
 *               snapshot — a draft is structurally unreachable)
 *   closed    → 200 { status: "closed" } — unpublished AND soft-deleted forms
 *   redirect  → 308 Location: /f/{canonicalSlug} (superseded registry entry)
 *   not_found → 404 problem
 *
 * EVERY response carries `Cache-Control: no-store`; the route needs NO cookie
 * and NO Origin header (cookie-less public allowlist entry + safe method).
 */

const SCRATCH_DB = "t09_public_api";
let fx: AuthCoreFixture;
let app: Express;
let admin: AuthCoreFixture["adminClient"];

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
    .send({ name: "Public User", email, password, callbackURL: "/dashboard" });
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

async function newVerifiedUser(prefix: string): Promise<{ email: string; cookie: string }> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t09.example`;
  await signUp(email);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
  const cookie = await signIn(email);
  return { email, cookie };
}

async function newWorkspaceUser(
  prefix: string,
): Promise<{ email: string; cookie: string; workspaceId: string }> {
  const { email, cookie } = await newVerifiedUser(prefix);
  const res = await request(app)
    .post("/v1/workspaces/bootstrap")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(res.status).toBe(200);
  return { email, cookie, workspaceId: res.body.workspace.id as string };
}

function createForm(cookie: string) {
  return request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({});
}

function bid(n: number): string {
  const id = `b${String(n).padStart(11, "0")}`;
  expect(id).toMatch(BLOCK_ID_RE);
  return id;
}

function publishableEnvelope(overrides: Record<string, unknown> = {}): FormSchema {
  return {
    ...emptyDraft(),
    title: "Feedback survey <script>alert(1)</script>",
    blocks: [
      {
        id: bid(1),
        kind: "short_text",
        label: "What can we improve? <b>bold</b>",
        description: "Be specific <img src=x onerror=alert(2)>",
        required: false,
        placeholder: "Type here <script>alert(3)</script>",
      },
      { id: bid(2), kind: "ending", title: "Thanks <i>a lot</i>" },
    ],
    ...overrides,
  } as FormSchema;
}

async function saveDraft(
  cookie: string,
  formId: string,
  schema: FormSchema,
  draftVersion: number,
) {
  return request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({ schema: schema as unknown, draftVersion });
}

async function publish(cookie: string, formId: string) {
  const res = await request(app)
    .post(`/v1/forms/${formId}/publish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(res.status).toBe(200);
  return res.body as { slug: string; versionNumber: number };
}

/** Publishes a fresh form and returns it + the user's cookie. */
async function publishedForm(prefix: string) {
  const user = await newWorkspaceUser(prefix);
  const form = (await createForm(user.cookie)).body as FormDetail;
  await saveDraft(user.cookie, form.id, publishableEnvelope(), 0);
  const published = await publish(user.cookie, form.id);
  return { ...user, form, slug: published.slug };
}

function getPublic(slug: string, options: { origin?: string | null } = {}) {
  const req = request(app).get(`/v1/public/forms/${slug}`);
  if (options.origin !== null) req.set("Origin", options.origin ?? fx.appName);
  return req;
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
  admin = fx.adminClient;
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("GET /v1/public/forms/{slug}", () => {
  it("serves the published snapshot UNauthenticated, cookie-less, Origin-less, no-store", async () => {
    const { slug } = await publishedForm("pub-live");

    // Deliberately NO Cookie header and NO Origin header: the endpoint is on
    // the cookie-less public allowlist and GET is a safe method.
    const res = await getPublic(slug, { origin: null });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.status).toBe("published");
    expect(res.body.versionNumber).toBe(1);
    expect(res.body.versionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Creator text arrives RAW (JSON) — escaping is the renderer's job.
    expect(res.body.schema.title).toBe("Feedback survey <script>alert(1)</script>");
    expect(res.body.schema.blocks[0].label).toContain("<b>bold</b>");
  });

  it("unpublished forms read closed (200), not 404 — with no-store", async () => {
    const user = await newWorkspaceUser("pub-closed");
    const form = (await createForm(user.cookie)).body as FormDetail;
    await saveDraft(user.cookie, form.id, publishableEnvelope(), 0);
    const { slug } = await publish(user.cookie, form.id);
    await request(app)
      .post(`/v1/forms/${form.id}/unpublish`)
      .set("Origin", fx.appName)
      .set("Cookie", user.cookie)
      .send()
      .expect(200);

    const res = await getPublic(slug).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ status: "closed" });
  });

  it("soft-deleted forms read closed too (a respondent never gets a generic 404)", async () => {
    const user = await newWorkspaceUser("pub-del");
    const form = (await createForm(user.cookie)).body as FormDetail;
    await saveDraft(user.cookie, form.id, publishableEnvelope(), 0);
    const { slug } = await publish(user.cookie, form.id);

    await admin.query(
      `UPDATE app.forms SET deleted_at = now() WHERE workspace_id = $1 AND id = $2`,
      [user.workspaceId, form.id],
    );

    const res = await getPublic(slug).expect(200);
    expect(res.body).toEqual({ status: "closed" });
  });

  it("superseded slugs answer 308 to /f/{canonicalSlug} with no-store", async () => {
    const { slug: oldSlug, form, workspaceId } = await publishedForm("pub-308");

    // Rename through the registry seam (M0 has no rename UI): the old slug
    // stays in the registry as a redirect.
    const newSlug = "N3wCan0n1c";
    await admin.query(`SELECT set_config('app.workspace_id', $1, false)`, [workspaceId]);
    await admin.query(`SELECT app.register_form_slug($1::uuid, $2)`, [form.id, newSlug]);
    await admin.query(`SELECT set_config('app.workspace_id', '', false)`);

    const res = await getPublic(oldSlug, { origin: null });
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`/f/${newSlug}`);
    expect(res.headers["cache-control"]).toBe("no-store");

    const canonical = await getPublic(newSlug).expect(200);
    expect(canonical.body.status).toBe("published");
  });

  it("unknown and malformed slugs are 404 problems with no-store", async () => {
    const missing = await getPublic("ZZZZZZZZZ9", { origin: null });
    expect(missing.status).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.body.code).toBe("not_found");

    const malformed = await getPublic("short-nope");
    expect(malformed.status).toBe(404);
    expect(malformed.headers["cache-control"]).toBe("no-store");
  });

  it("never returns a draft: unpublish-edits stay invisible until republish", async () => {
    const user = await newWorkspaceUser("pub-iso");
    const form = (await createForm(user.cookie)).body as FormDetail;
    await saveDraft(user.cookie, form.id, publishableEnvelope(), 0);
    const { slug } = await publish(user.cookie, form.id);

    // Draft edits AFTER publish never leak through the public endpoint.
    const edited = publishableEnvelope({ title: "DRAFT ONLY — not public" });
    await saveDraft(user.cookie, form.id, edited, 1);

    const res = await getPublic(slug).expect(200);
    expect(res.body.schema.title).toBe("Feedback survey <script>alert(1)</script>");
    expect(res.body.schema.title).not.toContain("DRAFT ONLY");
    expect(res.body.versionNumber).toBe(1);
  });
});
