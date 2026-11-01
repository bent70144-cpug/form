import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { emptyDraft, type FormSchema } from "@form/form-schema";
import {
  listSubmissionsResponseSchema,
  submissionDetailSchema,
  type SubmissionDetail,
} from "@form/contracts";
import { en } from "@form/i18n";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 11 API slice — the submission inbox, end-to-end over the real HTTP
 * stack (supertest against createApiApp, embedded Postgres, REAL roles):
 *
 *   GET /v1/forms/{formId}/submissions                  — newest-first by
 *     (created_at, id), cursor pagination (default 20, max 100); unknown/
 *     cross-workspace form → 404 (never 403 — no enumeration); malformed
 *     pagination → 422 validation_failed.
 *   GET /v1/forms/{formId}/submissions/{submissionId}   — answers + the
 *     PINNED version's schema: after a republish the OLD submission still
 *     pairs with the OLD version's labels and reports versionNumber 1 —
 *     the current draft never leaks into history.
 *
 * Submissions are created through the REAL public flow of ticket 10
 * (POST /v1/public/forms/{slug}/sessions → POST /v1/public/submissions).
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
    .send({ name: "T11 Reviewer", email, password: "correct-horse-12", callbackURL: "/dashboard" });
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

const Q_NAME = "a0000000001";
const Q_FEEDBACK = "a0000000002";
const Q_ENDING = "a0000000003";

/** v1 envelope — the label the first submission is paired with. */
function envelopeV1(nameLabel: string): FormSchema {
  return {
    ...emptyDraft(),
    title: "Tell us",
    blocks: [
      { id: Q_NAME, kind: "short_text", label: nameLabel, required: true },
      { id: Q_FEEDBACK, kind: "long_text", label: "Any feedback?", required: false },
      { id: Q_ENDING, kind: "ending", title: "Thanks!" },
    ],
  } as FormSchema;
}

async function saveDraft(
  cookie: string,
  formId: string,
  schema: FormSchema,
  draftVersion: number,
): Promise<void> {
  const saved = await request(app)
    .put(`/v1/forms/${formId}/draft`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send({ schema: schema as unknown, draftVersion });
  expect(saved.status).toBe(200);
}

interface PublishedForm {
  formId: string;
  slug: string;
}

async function publishForm(cookie: string, nameLabel = "Your name"): Promise<PublishedForm> {
  const created = await request(app)
    .post("/v1/forms")
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(created.status).toBe(201);
  const formId = created.body.id as string;
  await saveDraft(cookie, formId, envelopeV1(nameLabel), 0);
  const published = await request(app)
    .post(`/v1/forms/${formId}/publish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(published.status).toBe(200);
  return { formId, slug: published.body.slug as string };
}

let submitSeq = 0;

/** One REAL public submission: new pinned session → answers. */
async function submitOnce(slug: string, name: string): Promise<string> {
  submitSeq += 1;
  const session = await request(app)
    .post(`/v1/public/forms/${slug}/sessions`)
    .send();
  expect(session.status).toBe(200);
  const submitted = await request(app)
    .post("/v1/public/submissions")
    .set("X-Form-Session", session.body.token as string)
    .send({ answers: { [Q_NAME]: name, [Q_FEEDBACK]: `note ${submitSeq}` } });
  expect(submitted.status).toBe(200);
  return submitted.body.submissionId as string;
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
}, 120_000);

afterAll(async () => {
  await fx.close();
});

describe("GET /v1/forms/{formId}/submissions", () => {
  it("paginates newest-first: 25 submissions → 20 + cursor → 5 + null cursor", async () => {
    const user = await newWorkspaceUser("inbox-paging");
    const form = await publishForm(user.cookie);

    // 25 submissions in chronological order; ids[i] submitted i-th.
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(await submitOnce(form.slug, `Person ${String(i + 1).padStart(2, "0")}`));
    }

    const page1 = await listSubmissions(user.cookie, form.formId);
    expect(page1.status).toBe(200);
    expect(listSubmissionsResponseSchema.safeParse(page1.body).success).toBe(true);
    expect(page1.body.submissions).toHaveLength(20);
    // Newest first: the most recently submitted id leads page 1.
    expect(page1.body.submissions[0]!.id).toBe(ids[24]!);
    expect(page1.body.submissions[19]!.id).toBe(ids[5]!);
    expect(typeof page1.body.nextCursor).toBe("string");

    const page2 = await listSubmissions(
      user.cookie,
      form.formId,
      `?cursor=${encodeURIComponent(page1.body.nextCursor as string)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.submissions).toHaveLength(5);
    expect(page2.body.submissions[0]!.id).toBe(ids[4]!);
    expect(page2.body.submissions[4]!.id).toBe(ids[0]!);
    expect(page2.body.nextCursor).toBeNull();

    // The carried preview is the first answer text of each submission
    // (jsonb object keys are stored sorted: Q_NAME < Q_FEEDBACK).
    expect(page1.body.submissions[0]!.preview).toBe("Person 25");
  });

  it("honors limit (capped at 100 by the contract) and rejects invalid pagination", async () => {
    const user = await newWorkspaceUser("inbox-limits");
    const form = await publishForm(user.cookie);

    const big = await listSubmissions(user.cookie, form.formId, "?limit=100");
    expect(big.status).toBe(200);
    expect(big.body.submissions).toHaveLength(0); // empty inbox, valid limit

    const over = await listSubmissions(user.cookie, form.formId, "?limit=101");
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("validation_failed");

    const zero = await listSubmissions(user.cookie, form.formId, "?limit=0");
    expect(zero.status).toBe(422);

    const badCursor = await listSubmissions(
      user.cookie,
      form.formId,
      "?cursor=%%%not-base64",
    );
    expect(badCursor.status).toBe(422);
    expect(badCursor.body.code).toBe("validation_failed");
    expect(badCursor.body.errors?.[0]?.path).toBe("cursor");
  });

  it("404s: unknown id, non-UUID id, and another workspace's form (never 403)", async () => {
    const owner = await newWorkspaceUser("inbox-owner");
    const form = await publishForm(owner.cookie);
    await submitOnce(form.slug, "Ada Lovelace");

    const stranger = await newWorkspaceUser("inbox-stranger");

    // Unknown (random) form id.
    const unknown = await listSubmissions(
      owner.cookie,
      "018f0000-0000-7000-8000-0000000000ff",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");

    // Non-UUID form id — must never reach a uuid-typed SQL cast.
    const nonUuid = await listSubmissions(owner.cookie, "not-a-uuid");
    expect(nonUuid.status).toBe(404);

    // Cross-workspace: the stranger's RLS context cannot see the form.
    const cross = await listSubmissions(stranger.cookie, form.formId);
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe("not_found");
  });

  it("401 without a session", async () => {
    const user = await newWorkspaceUser("inbox-auth");
    const form = await publishForm(user.cookie);
    const res = await request(app).get(`/v1/forms/${form.formId}/submissions`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthenticated");
  });
});

describe("GET /v1/forms/{formId}/submissions/{submissionId}", () => {
  it("pairs answers with the PINNED version's labels — not the current draft", async () => {
    const user = await newWorkspaceUser("inbox-pinned");
    const form = await publishForm(user.cookie, "Your name");
    const v1SubmissionId = await submitOnce(form.slug, "Ada Lovelace");

    // Republish with a CHANGED label → version 2 becomes current; the old
    // submission stays pinned to version 1.
    const detail0 = await request(app)
      .get(`/v1/forms/${form.formId}`)
      .set("Cookie", user.cookie);
    expect(detail0.status).toBe(200);
    const draftVersion = detail0.body.draft.draftVersion as number;
    await saveDraft(
      user.cookie,
      form.formId,
      envelopeV1("Your full name"),
      draftVersion,
    );
    const republished = await request(app)
      .post(`/v1/forms/${form.formId}/publish`)
      .set("Origin", fx.appName)
      .set("Cookie", user.cookie)
      .send();
    expect(republished.status).toBe(200);
    expect(republished.body.versionNumber).toBe(2);

    const res = await getSubmission(user.cookie, form.formId, v1SubmissionId);
    expect(res.status).toBe(200);
    expect(submissionDetailSchema.safeParse(res.body).success).toBe(true);
    const detail = res.body as SubmissionDetail;

    // History is version 1, with version 1's label.
    expect(detail.submission.formVersion.versionNumber).toBe(1);
    expect(detail.pinnedSchema.schemaVersion).toBe(1);
    const nameBlock = detail.pinnedSchema.blocks.find((b) => b.id === Q_NAME);
    expect(nameBlock && nameBlock.kind === "short_text" && nameBlock.label).toBe("Your name");

    // The stored answers are intact and keyed by block id.
    expect(detail.submission.answers).toEqual({
      [Q_NAME]: "Ada Lovelace",
      [Q_FEEDBACK]: expect.any(String),
    });
    expect(new Date(detail.submission.submittedAt).toString()).not.toBe("Invalid Date");
  });

  it("submissions of the new version report the new version number", async () => {
    const user = await newWorkspaceUser("inbox-v2");
    const form = await publishForm(user.cookie, "First name");

    const detail0 = await request(app)
      .get(`/v1/forms/${form.formId}`)
      .set("Cookie", user.cookie);
    await saveDraft(
      user.cookie,
      form.formId,
      envelopeV1("Given name"),
      detail0.body.draft.draftVersion as number,
    );
    const republished = await request(app)
      .post(`/v1/forms/${form.formId}/publish`)
      .set("Origin", fx.appName)
      .set("Cookie", user.cookie)
      .send();
    expect(republished.status).toBe(200);

    const v2SubmissionId = await submitOnce(form.slug, "Grace Hopper");
    const res = await getSubmission(user.cookie, form.formId, v2SubmissionId);
    expect(res.status).toBe(200);
    expect(res.body.submission.formVersion.versionNumber).toBe(2);
    const nameBlock = res.body.pinnedSchema.blocks.find((b) => b.id === Q_NAME);
    expect(nameBlock.label).toBe("Given name");
  });

  it("404s: unknown submission, another form's submission, cross-workspace submission", async () => {
    const owner = await newWorkspaceUser("inbox-detail-404");
    const formA = await publishForm(owner.cookie);
    const formB = await publishForm(owner.cookie);
    const submissionA = await submitOnce(formA.slug, "Ada Lovelace");

    const stranger = await newWorkspaceUser("inbox-detail-stranger");

    // Unknown submission id (well-formed UUID).
    const unknown = await getSubmission(
      owner.cookie,
      formA.formId,
      "018f0000-0000-7000-8000-0000000000aa",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");

    // Non-UUID submission id.
    const nonUuid = await getSubmission(owner.cookie, formA.formId, "nope");
    expect(nonUuid.status).toBe(404);

    // The RIGHT submission under the WRONG form of the same workspace.
    const wrongForm = await getSubmission(owner.cookie, formB.formId, submissionA);
    expect(wrongForm.status).toBe(404);

    // Another workspace's submission.
    const cross = await getSubmission(stranger.cookie, formA.formId, submissionA);
    expect(cross.status).toBe(404);
  });

  it("i18n: the inbox copy lives in the shared catalog, not in route code", async () => {
    // The route layer owns no user-facing inbox strings; the dashboard does.
    expect(en.dashboard.inbox.title).toBe("Inbox");
    expect(en.dashboard.inbox.empty.length).toBeGreaterThan(0);
    expect(en.dashboard.inbox.submittedAt).toContain("{date}");
    expect(en.dashboard.inbox.formVersion).toContain("{version}");
  });
});
