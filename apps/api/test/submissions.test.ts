import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import type { SubmissionDetail } from "@form/contracts";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 11 API slice — the dashboard submission inbox, end-to-end over the
 * real HTTP stack (supertest against createApiApp, embedded Postgres, REAL
 * roles):
 *
 *   GET /v1/forms/{formId}/submissions           cursor pagination, newest
 *                                                first by (created_at, id),
 *                                                default 20 / max 100
 *   GET /v1/forms/{formId}/submissions/{sid}     detail: each answer paired
 *                                                with its label from the
 *                                                PINNED version's schema
 *                                                (NOT the mutable draft) +
 *                                                received time + version
 *
 * Cross-workspace list AND detail answer 404 (never 403 — no enumeration);
 * the submissions tables' forced RLS is proven at the database seam
 * (packages/database/test/submissions-rls.test.ts).
 */

const SCRATCH_DB = "t11_inbox_api";
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

async function newWorkspaceUser(
  prefix: string,
): Promise<{ cookie: string; workspaceId: string }> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t11.example`;
  const signedUp = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "T11 Owner", email, password: "correct-horse-12", callbackURL: "/dashboard" });
  expect(signedUp.status).toBe(200);
  const raw = await waitForMailTo(email);
  const url = new URL(extractVerificationUrl(raw));
  const verified = await request(app).get(`${url.pathname}${url.search}`);
  expect([200, 302]).toContain(verified.status);
  const signIn = await request(app)
    .post("/v1/auth/sign-in/email")
    .set("Origin", fx.appName)
    .send({ email, password: "correct-horse-12" });
  expect(signIn.status).toBe(200);
  const cookie = cookieHeaderOf(signIn.headers["set-cookie"]);
  const bootstrapped = await request(app)
    .post("/v1/workspaces/bootstrap")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(bootstrapped.status).toBe(200);
  return { cookie, workspaceId: bootstrapped.body.workspace.id as string };
}

const B_WELCOME = "b11000000001";
const B_NAME = "b11000000002";
const B_STORY = "b11000000003";
const B_ENDING = "b11000000004";

function envelope(nameLabel: string): FormSchema {
  [B_WELCOME, B_NAME, B_STORY, B_ENDING].forEach((id) =>
    expect(id).toMatch(BLOCK_ID_RE),
  );
  return {
    ...emptyDraft(),
    title: "Client intake",
    blocks: [
      { id: B_WELCOME, kind: "welcome", title: "Welcome" },
      { id: B_NAME, kind: "short_text", label: nameLabel, required: true },
      { id: B_STORY, kind: "long_text", label: "Your story", required: false },
      { id: B_ENDING, kind: "ending", title: "Thanks!" },
    ],
  } as FormSchema;
}

interface PublishedForm {
  formId: string;
  slug: string;
  versionNumber: number;
}

async function createPublishedForm(
  cookie: string,
  nameLabel = "Full legal name",
): Promise<PublishedForm> {
  const created = await request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(created.status).toBe(201);
  const formId = created.body.id as string;
  const saved = await request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({ schema: envelope(nameLabel) as unknown, draftVersion: 0 });
  expect(saved.status).toBe(200);
  const published = await request(app)
    .post(`/v1/forms/${formId}/publish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(published.status).toBe(200);
  return {
    formId,
    slug: published.body.slug as string,
    versionNumber: published.body.versionNumber as number,
  };
}

async function newSession(slug: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/public/forms/${slug}/sessions`)
    .send();
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function submitAnswers(
  slug: string,
  answers: Record<string, string>,
): Promise<string> {
  const token = await newSession(slug);
  const res = await request(app)
    .post("/v1/public/submissions")
    .set("X-Form-Session", token)
    .send({ answers });
  expect(res.status).toBe(200);
  return res.body.submissionId as string;
}

function listSubmissions(cookie: string, formId: string, query = "") {
  return request(app)
    .get(`/v1/forms/${formId}/submissions${query}`)
    .set("Cookie", cookie);
}

function getSubmission(cookie: string, formId: string, submissionId: string) {
  return request(app)
    .get(`/v1/forms/${formId}/submissions/${submissionId}`)
    .set("Cookie", cookie);
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB);
  app = fx.expressApp;
});

afterAll(async () => {
  await fx.close();
});

describe("GET /v1/forms/{id}/submissions (ticket 11)", () => {
  it("lists newest-first with received time + pinned version number", async () => {
    const user = await newWorkspaceUser("list-order");
    const form = await createPublishedForm(user.cookie);
    const first = await submitAnswers(form.slug, {
      [B_NAME]: "First Respondent",
    });
    const second = await submitAnswers(form.slug, {
      [B_NAME]: "Second Respondent",
    });

    const res = await listSubmissions(user.cookie, form.formId);
    expect(res.status).toBe(200);
    const ids = (res.body.submissions as Array<{ id: string; createdAt: string; formVersionNumber: number }>).map(
      (s) => s.id,
    );
    expect(ids).toEqual([second, first]);
    for (const summary of res.body.submissions as Array<{
      createdAt: string;
      formVersionNumber: number;
    }>) {
      expect(Number.isNaN(Date.parse(summary.createdAt))).toBe(false);
      expect(summary.formVersionNumber).toBe(form.versionNumber);
    }
    expect(res.body.nextCursor).toBeNull();
  });

  it("paginates by cursor with default 20 / max 100 (limit validated)", async () => {
    const user = await newWorkspaceUser("list-pages");
    const form = await createPublishedForm(user.cookie);
    for (let i = 0; i < 3; i++) {
      await submitAnswers(form.slug, { [B_NAME]: `Respondent ${i}` });
    }

    // Default page size carries everything here.
    const full = await listSubmissions(user.cookie, form.formId);
    expect(full.status).toBe(200);
    expect(full.body.submissions).toHaveLength(3);

    // limit=2 → first page + cursor; cursor page carries the remainder.
    const page1 = await listSubmissions(user.cookie, form.formId, "?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.submissions).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await listSubmissions(
      user.cookie,
      form.formId,
      `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.submissions).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    const pageIds = [
      ...(page1.body.submissions as Array<{ id: string }>),
      ...(page2.body.submissions as Array<{ id: string }>),
    ].map((s) => s.id);
    expect(pageIds).toEqual((full.body.submissions as Array<{ id: string }>).map((s) => s.id));

    // limit > 100 and limit < 1 are 422 validation failures.
    const tooBig = await listSubmissions(user.cookie, form.formId, "?limit=101");
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.code).toBe("validation_failed");
    const tooSmall = await listSubmissions(user.cookie, form.formId, "?limit=0");
    expect(tooSmall.status).toBe(422);

    // A malformed cursor is 422 with a `cursor` field error, never a crash.
    const badCursor = await listSubmissions(user.cookie, form.formId, "?cursor=@@not-a-cursor@@");
    expect(badCursor.status).toBe(422);
    expect(badCursor.body.errors?.[0]?.path).toBe("cursor");
  });

  it("empty page for a form with no submissions; 404 for unknown and non-UUID ids", async () => {
    const user = await newWorkspaceUser("list-empty");
    const form = await createPublishedForm(user.cookie);

    const empty = await listSubmissions(user.cookie, form.formId);
    expect(empty.status).toBe(200);
    expect(empty.body.submissions).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();

    const missing = await listSubmissions(
      user.cookie,
      "018f0b2e-6f7a-7c3e-9a1b-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");

    const notUuid = await listSubmissions(user.cookie, "not-a-uuid");
    expect(notUuid.status).toBe(404);
  });

  it("cross-workspace list is a 404 (RLS hides the foreign form)", async () => {
    const owner = await newWorkspaceUser("list-owner");
    const stranger = await newWorkspaceUser("list-stranger");
    const form = await createPublishedForm(owner.cookie);
    await submitAnswers(form.slug, { [B_NAME]: "Ada" });

    const res = await listSubmissions(stranger.cookie, form.formId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("unauthenticated list is 401", async () => {
    const user = await newWorkspaceUser("list-anon");
    const form = await createPublishedForm(user.cookie);
    const res = await listSubmissions("", form.formId);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/forms/{id}/submissions/{sid} (ticket 11)", () => {
  it("pairs each answer with the label from the PINNED version", async () => {
    const user = await newWorkspaceUser("detail-pair");
    const form = await createPublishedForm(user.cookie, "Full legal name");
    const submissionId = await submitAnswers(form.slug, {
      [B_NAME]: "Ada Lovelace",
      [B_STORY]: "Punched cards <script>alert('x')</script> & tags",
    });

    const res = await getSubmission(user.cookie, form.formId, submissionId);
    expect(res.status).toBe(200);
    const detail = res.body as SubmissionDetail;
    expect(detail.id).toBe(submissionId);
    expect(detail.formVersionNumber).toBe(form.versionNumber);
    expect(Number.isNaN(Date.parse(detail.createdAt))).toBe(false);
    // Pinned-block order, questions only, raw text (escaping is the web's job).
    expect(detail.answers).toEqual([
      { blockId: B_NAME, label: "Full legal name", answer: "Ada Lovelace" },
      {
        blockId: B_STORY,
        label: "Your story",
        answer: "Punched cards <script>alert('x')</script> & tags",
      },
    ]);
  });

  it("labels come from the PINNED version — a later draft edit does not re-label", async () => {
    const user = await newWorkspaceUser("detail-pinned");
    const form = await createPublishedForm(user.cookie, "Pinned label");
    const submissionId = await submitAnswers(form.slug, { [B_NAME]: "Grace" });

    // Move the DRAFT's label on (republish would pin a new version; we don't).
    const detailForm = await request(app)
      .get(`/v1/forms/${form.formId}`)
      .set("Cookie", user.cookie);
    expect(detailForm.status).toBe(200);
    const draft = detailForm.body.draft;
    draft.schema.blocks = draft.schema.blocks.map(
      (b: { id: string; label?: string }) =>
        b.id === B_NAME ? { ...b, label: "Edited draft label" } : b,
    );
    const saved = await request(app)
      .put(`/v1/forms/${form.formId}/draft`)
      .set("Origin", fx.appName)
      .set("Cookie", user.cookie)
      .send({ schema: draft.schema, draftVersion: draft.draftVersion });
    expect(saved.status).toBe(200);

    const res = await getSubmission(user.cookie, form.formId, submissionId);
    expect(res.status).toBe(200);
    expect(
      (res.body as SubmissionDetail).answers.find((a) => a.blockId === B_NAME),
    ).toEqual({ blockId: B_NAME, label: "Pinned label", answer: "Grace" });
  });

  it("404 for unknown, cross-workspace, wrong-form, and non-UUID submissions", async () => {
    const owner = await newWorkspaceUser("detail-owner");
    const stranger = await newWorkspaceUser("detail-stranger");
    const form = await createPublishedForm(owner.cookie);
    const otherForm = await createPublishedForm(owner.cookie);
    const submissionId = await submitAnswers(form.slug, { [B_NAME]: "Ada" });

    const missing = await getSubmission(
      owner.cookie,
      form.formId,
      "018f0b2e-6f7a-7c3e-9a1b-000000000000",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");

    // Another workspace: 404, indistinguishable from unknown.
    const foreign = await getSubmission(stranger.cookie, form.formId, submissionId);
    expect(foreign.status).toBe(404);

    // A REAL submission addressed under a DIFFERENT form of the same
    // workspace is still a 404 (form-scoped resource).
    const wrongForm = await getSubmission(owner.cookie, otherForm.formId, submissionId);
    expect(wrongForm.status).toBe(404);

    const notUuid = await getSubmission(owner.cookie, form.formId, "nope");
    expect(notUuid.status).toBe(404);
  });
});
