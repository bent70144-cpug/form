import { createHash } from "node:crypto";
import { Injectable, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import { uuidv7 } from "@form/database";
import {
  validateAnswers,
  type FormSchema,
  type Issue,
} from "@form/form-schema";
import type { ErrorCode, SubmitReceipt } from "@form/contracts";
import { APP_DB_POOL } from "../db/app-db";
import { withPublicTransaction, type PublicDb } from "./public-transaction";

/**
 * Public submission service (ticket 10) — `POST /v1/public/submissions`, ONE
 * transaction per spec's "Public form and submission lifecycle" steps 1-9:
 *
 *   1. Resolve the session by the SHA-256 of the raw `X-Form-Session` token
 *      through the security-definer `resolve_form_session(token_hash)`.
 *   2. Reject unknown (404 `session_not_found`), expired-beyond-the-5-minute-
 *      grace (410 `session_expired`) and completed sessions — a completed
 *      session with a stored submission is the IDEMPOTENT path and returns
 *      the original receipt; a completed session WITHOUT one is a data
 *      anomaly → 409 `session_completed`.
 *   3. Verify the form is still published and the pinned version still
 *      exists — unpublished/soft-deleted forms (even with a pinned session)
 *      → 409 `form_closed`.
 *   4. Validate the answer object against the PINNED schema with the shared
 *      `validateAnswers` engine (unknown block ids, answers to non-question
 *      blocks, missing/whitespace-only required answers, per-kind character
 *      caps, NUL `invalid_character`, 100 KB `submission_too_large`) — 422
 *      `validation_failed` with the engine's stable per-answer codes, and
 *      NOTHING is persisted.
 *   5. (Hidden-block discard is structural in M0 — inside validateAnswers.)
 *   6. Lock the form row (`SELECT … FOR UPDATE`) and enforce the per-form
 *      submission cap (FORM_SUBMISSION_CAP, default 1000) → 409 `form_full`.
 *   7. Insert the submission — UNIQUE `form_session_id` makes the session the
 *      idempotency key: a retry or the loser of a concurrent double-submit
 *      race catches the unique violation and returns the SAME receipt
 *      WITHOUT stored answers.
 *   8. Mark the session completed.
 *   9. Insert the `submission.created` audit row + outbox event (no RETURNING
 *      on the outbox insert — INSERT-only grant).
 *
 * `app.workspace_id` is set inside the transaction from the RESOLVED session
 * — never from the client; a forged X-Workspace-Id header is ignored.
 */

export class SubmitProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly issues?: Issue[],
  ) {
    super(`submit: ${code}`);
  }
}

export interface SubmitOutcome {
  receipt: SubmitReceipt;
  /** True when the receipt came from the pre-existing submission (retry/race loser). */
  idempotent: boolean;
}

interface ResolvedSession {
  sessionId: string;
  workspaceId: string;
  formId: string;
  formVersionId: string;
  versionNumber: number | null;
  state: "usable" | "within_grace" | "expired_beyond_grace";
  completed: boolean;
  formStatus: string | null;
  formDeleted: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

@Injectable()
export class PublicSubmissionsService {
  constructor(
    @Inject(APP_DB_POOL) private readonly pool: Pool,
    @Inject("PUBLIC_SUBMISSION_CAP") private readonly submissionCap: number,
  ) {}

  async submit(token: string, answers: unknown): Promise<SubmitOutcome> {
    const tokenHash = createHash("sha256").update(token).digest("hex");

    return withPublicTransaction(
      this.pool,
      // The workspace is bound INSIDE the transaction from the resolved
      // session (spec: never from the client) — the resolve call itself needs
      // no context and is not a tenant-table query.
      null,
      async (tx) => this.submitTx(tx, tokenHash, answers),
    );
  }

  private async submitTx(
    tx: PublicDb,
    tokenHash: string,
    answers: unknown,
  ): Promise<SubmitOutcome> {
    // Step 1 — resolve by token hash (cross-tenant security-definer call).
    const resolvedResult = await tx.query<{ result: ResolvedSession | null }>(
      `SELECT app.resolve_form_session($1) AS result`,
      [tokenHash],
    );
    const resolved = resolvedResult.rows[0]?.result ?? null;
    if (!resolved) {
      throw new SubmitProblemError(404, "session_not_found");
    }

    // The workspace ALWAYS comes from the resolved session (spec). Bind it
    // transaction-locally before any tenant-table statement below.
    await tx.query("SELECT set_config('app.workspace_id', $1, true)", [
      resolved.workspaceId,
    ]);

    // Step 2 — state gates.
    if (resolved.state === "expired_beyond_grace") {
      throw new SubmitProblemError(410, "session_expired");
    }
    if (resolved.completed) {
      const existing = await this.findSubmissionIdBySession(tx, resolved);
      if (existing !== null) {
        return { receipt: { submitted: true, submissionId: existing }, idempotent: true };
      }
      throw new SubmitProblemError(409, "session_completed");
    }

    // Step 3 — form still published, pinned version still exists.
    if (
      resolved.formDeleted ||
      resolved.formStatus !== "published" ||
      resolved.versionNumber === null
    ) {
      throw new SubmitProblemError(409, "form_closed");
    }

    // Step 4 — validate answers against the PINNED schema (never the draft).
    const schemaResult = await tx.query<{ schema: unknown }>(
      `SELECT schema FROM app.form_versions
        WHERE workspace_id = $1 AND id = $2`,
      [resolved.workspaceId, resolved.formVersionId],
    );
    if (!schemaResult.rows[0]) {
      // The pinned version vanished mid-session — same closed semantics.
      throw new SubmitProblemError(409, "form_closed");
    }
    const validated = validateAnswers(schemaResult.rows[0].schema as FormSchema, answers);
    if (!validated.ok) {
      throw new SubmitProblemError(422, "validation_failed", validated.issues);
    }

    // Steps 6-9 run in a nested helper so the UNIQUE-violation catch below
    // can share the transaction without re-running validation.
    return this.insertSubmission(tx, resolved, validated.value);
  }

  private async insertSubmission(
    tx: PublicDb,
    resolved: ResolvedSession,
    answers: Record<string, string>,
  ): Promise<SubmitOutcome> {
    // Step 6 — lock the form row (serializes racers) and re-verify status
    // freshly INSIDE the lock, then enforce the per-form submission cap.
    const locked = await tx.query<{ status: string }>(
      `SELECT status FROM app.forms
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [resolved.workspaceId, resolved.formId],
    );
    if (!locked.rows[0] || locked.rows[0].status !== "published") {
      throw new SubmitProblemError(409, "form_closed");
    }
    const counted = await tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM app.submissions
        WHERE workspace_id = $1 AND form_id = $2 AND deleted_at IS NULL`,
      [resolved.workspaceId, resolved.formId],
    );
    if (counted.rows[0]!.count >= this.submissionCap) {
      throw new SubmitProblemError(409, "form_full");
    }

    // Step 7 — the idempotent insert. A retry that raced past the completed
    // check (or the loser of a double-submit) hits the UNIQUE constraint and
    // returns the winner's receipt — never a second row, never answers.
    const submissionId = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.submissions
           (id, workspace_id, form_id, form_version_id, form_session_id, answers, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb)`,
        [
          submissionId,
          resolved.workspaceId,
          resolved.formId,
          resolved.formVersionId,
          resolved.sessionId,
          JSON.stringify(answers),
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findSubmissionIdBySession(tx, resolved);
      if (existing === null) throw error;
      return { receipt: { submitted: true, submissionId: existing }, idempotent: true };
    }

    // Step 8 — mark the session completed.
    await tx.query(
      `UPDATE app.form_sessions
          SET completed_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND completed_at IS NULL`,
      [resolved.workspaceId, resolved.sessionId],
    );

    // Step 9 — audit + outbox in the SAME transaction (no RETURNING on the
    // outbox insert: app_user is INSERT-only there).
    await tx.query(
      `INSERT INTO app.audit_logs (id, workspace_id, actor, action, target_type, target_id, metadata)
       VALUES ($1, $2, NULL, 'submission.created', 'submission', $3, $4::jsonb)`,
      [
        uuidv7(),
        resolved.workspaceId,
        submissionId,
        JSON.stringify({
          formId: resolved.formId,
          sessionId: resolved.sessionId,
          versionId: resolved.formVersionId,
        }),
      ],
    );
    await tx.query(
      `INSERT INTO app.outbox_events (id, event_type, payload)
       VALUES ($1, 'submission.created', $2::jsonb)`,
      [
        uuidv7(),
        JSON.stringify({
          workspaceId: resolved.workspaceId,
          formId: resolved.formId,
          sessionId: resolved.sessionId,
          submissionId,
          versionId: resolved.formVersionId,
        }),
      ],
    );

    return { receipt: { submitted: true, submissionId }, idempotent: false };
  }

  /** The idempotency lookup — by (workspace, session) under RLS, id only. */
  private async findSubmissionIdBySession(
    tx: PublicDb,
    resolved: ResolvedSession,
  ): Promise<string | null> {
    const existing = await tx.query<{ id: string }>(
      `SELECT id::text FROM app.submissions
        WHERE workspace_id = $1 AND form_session_id = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [resolved.workspaceId, resolved.sessionId],
    );
    return existing.rows[0]?.id ?? null;
  }
}
