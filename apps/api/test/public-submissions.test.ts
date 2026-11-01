import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHash } from "node:crypto";
import { BLOCK_ID_RE, emptyDraft, type FormSchema } from "@form/form-schema";
import {
  createAuthCoreFixture,
  cookieHeaderOf,
  extractVerificationUrl,
  type AuthCoreFixture,
} from "./app-fixture";

/**
 * Ticket 10 API slice — public submissions, end-to-end over the real HTTP
 * stack (supertest against createApiApp, embedded Postgres, REAL roles).
 *
 * `POST /v1/public/submissions` runs ONE transaction per the spec's 9 steps:
 * resolve by token hash → state gates (404 unknown / 410 expired-beyond-grace
 * / idempotent receipt for completed) → form still published (409
 * `form_closed`) → validate against the PINNED schema (422 with the engine's
 * stable codes, nothing persisted) → lock the form row + per-form cap (409
 * `form_full`, env FORM_SUBMISSION_CAP=2 here) → idempotent insert (UNIQUE
 * form_session_id; the loser of a concurrent race gets the SAME receipt) →
 * mark completed → audit + outbox in the same transaction.
 *
 * The workspace ALWAYS comes from the resolved session: a forged
 * X-Workspace-Id header is ignored (asserted against the stored row).
 */

const SCRATCH_DB = "t10_submissions_api";
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

async function newWorkspaceUser(
  prefix: string,
): Promise<{ cookie: string; workspaceId: string }> {
  userSeq += 1;
  const email = `${prefix}-${Date.now()}-${userSeq}@t10.example`;
  const signedUp = await request(app)
    .post("/v1/auth/sign-up/email")
    .set("Origin", fx.appName)
    .send({ name: "T10 Submitter", email, password: "correct-horse-12", callbackURL: "/dashboard" });
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

const Q_WELCOME = "b00000000001";
const Q_NAME = "b00000000002";
const Q_STORY = "b00000000003";
const Q_ENDING = "b00000000004";

function envelope(): FormSchema {
  [Q_WELCOME, Q_NAME, Q_STORY, Q_ENDING].forEach((id, i) =>
    expect(id).toMatch(BLOCK_ID_RE),
  );
  void Q_ENDING;
  return {
    ...emptyDraft(),
    title: "Tell us a story",
    blocks: [
      { id: Q_WELCOME, kind: "welcome", title: "Welcome" },
      { id: Q_NAME, kind: "short_text", label: "Your name", required: true },
      { id: Q_STORY, kind: "long_text", label: "Your story", required: false },
      { id: Q_ENDING, kind: "ending", title: "Thanks!" },
    ],
  } as FormSchema;
}

interface PublishedForm {
  formId: string;
  slug: string;
  workspaceId: string;
}

async function publishForm(cookie: string): Promise<PublishedForm> {
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
    .send({ schema: envelope() as unknown, draftVersion: 0 });
  expect(saved.status).toBe(200);
  const published = await request(app)
    .post(`/v1/forms/${formId}/publish`)
    .set("Origin", fx.appName)
    .set("Cookie", cookie)
    .send();
  expect(published.status).toBe(200);
  return { formId, slug: published.body.slug as string, workspaceId: "" };
}

async function newSession(slug: string): Promise<string> {
  const res = await request(app)
    .post(`/v1/public/forms/${slug}/sessions`)
    .send();
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function submit(token: string, answers: unknown, headers: Record<string, string> = {}) {
  const req = request(app)
    .post("/v1/public/submissions")
    .set("X-Form-Session", token);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send({ answers });
}

async function submissionCount(formId: string): Promise<number> {
  const res = await admin.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM app.submissions WHERE form_id = $1`,
    [formId],
  );
  return res.rows[0]!.count;
}

beforeAll(async () => {
  fx = await createAuthCoreFixture(SCRATCH_DB, { FORM_SUBMISSION_CAP: "2" });
  app = fx.expressApp;
  admin = fx.adminClient;
});

afterAll(async () => {
  await fx.close();
});

describe("POST /v1/public/submissions (ticket 10)", () => {
  it("happy path: receipt, submission row, session completed, audit + outbox once", async () => {
    const user = await newWorkspaceUser("submit-happy");
    const form = await publishForm(user.cookie);
    const token = await newSession(form.slug);

    const res = await submit(token, { [Q_NAME]: "Ada Lovelace" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      submitted: true,
      submissionId: expect.any(String),
    });
    const submissionId = res.body.submissionId as string;

    const rows = await admin.query<{ answers: unknown; completed_at: Date | null }>(
      `SELECT s.answers, fs.completed_at
         FROM app.submissions s
         JOIN app.form_sessions fs ON fs.id = s.form_session_id
        WHERE s.id = $1`,
      [submissionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.answers).toEqual({ [Q_NAME]: "Ada Lovelace" });
    expect(rows.rows[0]!.completed_at).not.toBeNull();

    const audit = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM app.audit_logs
        WHERE action = 'submission.created' AND target_id = $1`,
      [submissionId],
    );
    expect(audit.rows[0]!.count).toBe(1);
    const outbox = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM app.outbox_events
        WHERE event_type = 'submission.created'
          AND payload->>'submissionId' = $1`,
      [submissionId],
    );
    expect(outbox.rows[0]!.count).toBe(1);
  });

  it("idempotent retry: the same token returns the SAME receipt without a duplicate row", async () => {
    const user = await newWorkspaceUser("submit-retry");
    const form = await publishForm(user.cookie);
    const token = await newSession(form.slug);

    const first = await submit(token, { [Q_NAME]: "Grace Hopper" });
    expect(first.status).toBe(200);
    const second = await submit(token, { [Q_NAME]: "Grace Hopper" });
    expect(second.status).toBe(200);
    expect(second.body.submissionId).toBe(first.body.submissionId);
    expect(await submissionCount(form.formId)).toBe(1);

    // The receipt NEVER carries stored answers.
    expect(Object.keys(second.body).sort()).toEqual(["submissionId", "submitted"]);
  });

  it("concurrent double-submit race: one insert wins, the loser gets the same receipt", async () => {
    const user = await newWorkspaceUser("submit-race");
    const form = await publishForm(user.cookie);
    const token = await newSession(form.slug);

    const [a, b] = await Promise.all([
      submit(token, { [Q_NAME]: "Racer One" }),
      submit(token, { [Q_NAME]: "Racer Two" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.submissionId).toBe(a.body.submissionId);
    expect(await submissionCount(form.formId)).toBe(1);
  });

  it("rejects validation problems with stable codes and persists NOTHING", async () => {
    const user = await newWorkspaceUser("submit-invalid");
    const form = await publishForm(user.cookie);

    const cases: Array<{ name: string; answers: unknown; code: string }> = [
      { name: "whitespace-only required answer", answers: { [Q_NAME]: "   " }, code: "required_answer_missing" },
      { name: "unknown block id", answers: { nope0000001: "x" }, code: "unknown_block_id" },
      { name: "answer to a welcome block", answers: { [Q_WELCOME]: "hi" }, code: "answer_to_non_question" },
      { name: "over-limit short text", answers: { [Q_NAME]: "x".repeat(1001) }, code: "answer_too_long" },
      { name: "NUL character", answers: { [Q_NAME]: "a\u0000b" }, code: "invalid_character" },
      {
        name: "byte-capped payload",
        answers: { [Q_NAME]: "ok", [Q_STORY]: "x".repeat(120_000) },
        code: "submission_too_large",
      },
    ];

    for (const c of cases) {
      const token = await newSession(form.slug);
      const res = await submit(token, c.answers);
      expect(res.status, c.name).toBe(422);
      expect(res.body.code, c.name).toBe("validation_failed");
      const codes = (res.body.errors as Array<{ path: string; code: string }>).map((e) => e.code);
      expect(codes, c.name).toContain(c.code);
      expect(await submissionCount(form.formId), c.name).toBe(0);
      // The failed session is still open (not completed): resubmitting valid
      // answers on the same token succeeds.
      const retry = await submit(token, { [Q_NAME]: "Ada" });
      expect(retry.status, c.name).toBe(200);
      expect(await submissionCount(form.formId), c.name).toBe(1);
      await admin.query(`DELETE FROM app.submissions WHERE form_id = $1`, [form.formId]);
      await admin.query(
        `UPDATE app.form_sessions SET completed_at = NULL WHERE form_id = $1`,
        [form.formId],
      );
    }
  });

  it("rejects missing (401) and unknown (404) session tokens", async () => {
    const noToken = await request(app)
      .post("/v1/public/submissions")
      .send({ answers: {} });
    expect(noToken.status).toBe(401);
    expect(noToken.body.code).toBe("session_required");

    const unknown = await submit(
      Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url"),
      { [Q_NAME]: "x" },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("session_not_found");
  });

  it("accepts submissions within the 5-minute grace; rejects beyond it with 410", async () => {
    const user = await newWorkspaceUser("submit-expiry");
    const form = await publishForm(user.cookie);

    const inGraceToken = await newSession(form.slug);
    await admin.query(
      `UPDATE app.form_sessions SET expires_at = now() - interval '2 minutes'
        WHERE token_hash = $1`,
      [createHash("sha256").update(inGraceToken).digest("hex")],
    );
    const inGrace = await submit(inGraceToken, { [Q_NAME]: "Grace" });
    expect(inGrace.status).toBe(200);

    const expiredToken = await newSession(form.slug);
    await admin.query(
      `UPDATE app.form_sessions SET expires_at = now() - interval '10 minutes'
        WHERE token_hash = $1`,
      [createHash("sha256").update(expiredToken).digest("hex")],
    );
    const expired = await submit(expiredToken, { [Q_NAME]: "Late" });
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe("session_expired");
  });

  it("rejects submissions for closed (unpublished) and soft-deleted forms with 409 form_closed", async () => {
    const user = await newWorkspaceUser("submit-closed");
    const unpublished = await publishForm(user.cookie);
    const unpublishedToken = await newSession(unpublished.slug);
    const closed = await request(app)
      .post(`/v1/forms/${unpublished.formId}/unpublish`)
      .set("Origin", fx.appName)
      .set("Cookie", user.cookie)
      .send();
    expect(closed.status).toBe(200);

    const res = await submit(unpublishedToken, { [Q_NAME]: "Ada" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("form_closed");

    // Soft-deleted: even a LIVE pinned session is rejected.
    const deleted = await publishForm(user.cookie);
    const deletedToken = await newSession(deleted.slug);
    await admin.query(`UPDATE app.forms SET deleted_at = now() WHERE id = $1`, [
      deleted.formId,
    ]);
    const res2 = await submit(deletedToken, { [Q_NAME]: "Ada" });
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe("form_closed");
  });

  it("enforces the per-form submission cap (FORM_SUBMISSION_CAP=2) with 409 form_full", async () => {
    const user = await newWorkspaceUser("submit-cap");
    const form = await publishForm(user.cookie);

    const first = await submit(await newSession(form.slug), { [Q_NAME]: "One" });
    const second = await submit(await newSession(form.slug), { [Q_NAME]: "Two" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const thirdToken = await newSession(form.slug);
    const third = await submit(thirdToken, { [Q_NAME]: "Three" });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("form_full");
    expect(await submissionCount(form.formId)).toBe(2);
    // The rejected session is NOT completed — it can retry when space frees.
    const pending = await admin.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM app.form_sessions WHERE token_hash = $1`,
      [createHash("sha256").update(thirdToken).digest("hex")],
    );
    expect(pending.rows[0]!.completed_at).toBeNull();
  });

  it("ignores a forged X-Workspace-Id header — the workspace always comes from the resolved session", async () => {
    const user = await newWorkspaceUser("submit-forged");
    const form = await publishForm(user.cookie);
    const token = await newSession(form.slug);
    const forged = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7c";

    const res = await submit(token, { [Q_NAME]: "Ada" }, { "X-Workspace-Id": forged });
    expect(res.status).toBe(200);

    const rows = await admin.query<{ workspace_id: string }>(
      `SELECT workspace_id::text FROM app.submissions WHERE id = $1`,
      [res.body.submissionId as string],
    );
    expect(rows.rows[0]!.workspace_id).not.toBe(forged);
  });
});
