import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { PublishResponse, UnpublishResponse } from "@form/contracts";
import { uuidv7, type TenantDb } from "@form/database";
import {
  SUBMISSION_JSON_MAX_BYTES,
  validatePublishSchema,
  worstCaseSubmissionBytes,
  type FormSchema,
  type Issue,
} from "@form/form-schema";

/**
 * Publish domain service (ticket 09) — the atomic publish/unpublish seam.
 *
 * Every method runs STRICTLY inside the request's tenant transaction (the
 * TenantRequestContextInterceptor opened it and set `app.user_id` +
 * `app.workspace_id` transaction-locally). Publish is ONE transaction per the
 * spec ("Publishing is one transaction"):
 *
 *   1. Lock the form row (`SELECT … FOR UPDATE`) — concurrent publishes
 *      serialize here; the loser waits, then allocates the next version.
 *   2. Re-run the FULL publish validation (`validatePublishSchema` — the same
 *      shared engine the builder's draft save uses, plus the publish-only
 *      structural rules). Any failure answers 422 and NOTHING is persisted.
 *   3. Allocate the next `version_number` (max + 1 per form).
 *   4. Insert the IMMUTABLE `form_versions` snapshot (the validated draft).
 *   5. Update `forms.published_version_id` + `status='published'` (the
 *      `current_draft_id` pointer is left intact — the draft stays editable).
 *   6. Register the public slug on FIRST publish via the security-definer
 *      `register_form_slug` (10-char base62, reserved words rejected,
 *      superseded entries kept as redirects). Republishes KEEP the current
 *      slug — M0 has no rename UI, and re-registering would pointlessly turn
 *      the live URL into a redirect.
 *   7. Insert the `form.published` audit row and outbox event.
 *
 * Any thrown error (e.g. an injected failure) propagates through the
 * interceptor's `withTenantTransaction`, which ROLLS BACK all of the above —
 * proven by the trigger-injection test in apps/api/test/publish.test.ts.
 *
 * NOTE: `app_user` has INSERT-only access to `outbox_events` (no SELECT, no
 * RETURNING) — same pattern as FormsService.create (ticket 06).
 */

/** base62 alphabet for slugs (the SQL layer re-enforces the format). */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Unbiased 10-character base62 slug. */
export function generateSlug(): string {
  let slug = "";
  // Rejection sampling keeps the distribution uniform over the alphabet.
  while (slug.length < 10) {
    const bytes = randomBytes(16);
    for (const byte of bytes) {
      if (byte >= 248) continue; // 248 = 4 * 62; keep the mapping uniform
      slug += BASE62[byte % 62];
      if (slug.length === 10) break;
    }
  }
  return slug;
}

export type PublishOutcome =
  | { ok: true; response: PublishResponse }
  | { ok: false; issues: Issue[] }
  /** The form does not exist in this workspace (→ 404, never 403). */
  | null;

interface FormLockRow {
  id: string;
  status: string;
}

interface PublishError extends Error {
  code?: string;
}

@Injectable()
export class PublishService {
  /**
   * Publishes (or republishes) the form as a new immutable version. Returns
   * `null` when the form is unknown or belongs to another workspace (RLS
   * hides it → 404), `{ ok: false, issues }` for publish-validation failures,
   * and the response payload on success.
   */
  async publish(
    tenant: TenantDb,
    formId: string,
    userId: string,
  ): Promise<PublishOutcome> {
    const workspaceId = tenant.context.workspaceId;

    // 1. Lock the form row — concurrent publishes serialize on this lock.
    const locked = await tenant.query<FormLockRow>(
      `SELECT id, status FROM app.forms
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [workspaceId, formId],
    );
    if (!locked.rows[0]) return null;

    // 2. The draft is the publish input. A form without its draft row is a
    //    bootstrap invariant violation (create() always makes both) — thrown,
    //    so the transaction rolls back rather than half-publishing.
    const draft = await tenant.query<{ schema: unknown }>(
      `SELECT schema FROM app.form_drafts
        WHERE workspace_id = $1 AND form_id = $2`,
      [workspaceId, formId],
    );
    if (!draft.rows[0]) {
      throw new Error(`publish: form ${formId} has no draft row`);
    }

    // FULL publish validation (ticket 07's engine + publish-only rules).
    const validated = validatePublishSchema(draft.rows[0].schema);
    if (!validated.ok) return { ok: false, issues: validated.issues };
    const schema: FormSchema = validated.value;

    // 3. Next version number (the row lock above serializes allocators).
    const next = await tenant.query<{ next: number }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
         FROM app.form_versions
        WHERE workspace_id = $1 AND form_id = $2`,
      [workspaceId, formId],
    );
    const versionNumber = next.rows[0]!.next;

    // 4. The immutable snapshot.
    const inserted = await tenant.query<{
      id: string;
      version_number: number;
      published_at: Date;
    }>(
      `INSERT INTO app.form_versions (id, workspace_id, form_id, version_number, schema, published_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id::text, version_number, published_at`,
      [uuidv7(), workspaceId, formId, versionNumber, JSON.stringify(schema), userId],
    );
    const version = inserted.rows[0]!;

    // 5. Flip the published pointer + status (current_draft_id stays intact).
    await tenant.query(
      `UPDATE app.forms
          SET status = 'published', published_version_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, formId, version.id],
    );

    // 6. Slug: allocated on the FIRST publish only; republishes keep theirs.
    const slug = await this.ensureCurrentSlug(tenant, workspaceId, formId);

    // 7. Audit + outbox in the same transaction (form.published, no RETURNING
    //    on the outbox insert — INSERT-only grant).
    await tenant.query(
      `INSERT INTO app.audit_logs (id, workspace_id, actor, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'form.published', 'form', $4, $5::jsonb)`,
      [
        uuidv7(),
        workspaceId,
        userId,
        formId,
        JSON.stringify({
          versionId: version.id,
          versionNumber,
          slug,
        }),
      ],
    );
    await tenant.query(
      `INSERT INTO app.outbox_events (id, event_type, payload)
       VALUES ($1, 'form.published', $2::jsonb)`,
      [
        uuidv7(),
        JSON.stringify({ workspaceId, formId, versionId: version.id, versionNumber, slug }),
      ],
    );

    return {
      ok: true,
      response: {
        formId,
        status: "published",
        versionId: version.id,
        versionNumber: version.version_number,
        slug,
        publishedAt: version.published_at.toISOString(),
        worstCaseBytes: worstCaseSubmissionBytes(schema),
        submissionCapBytes: SUBMISSION_JSON_MAX_BYTES,
      },
    };
  }

  /**
   * Unpublish: `status = 'closed'` (a respondent sees the closed message, not
   * a 404) plus the `form.unpublished` audit row and outbox event, all in the
   * request's transaction. Returns `null` for unknown/foreign forms (→ 404).
   */
  async unpublish(
    tenant: TenantDb,
    formId: string,
    userId: string,
  ): Promise<UnpublishResponse | null> {
    const workspaceId = tenant.context.workspaceId;

    const updated = await tenant.query<{ id: string }>(
      `UPDATE app.forms
          SET status = 'closed', updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id::text`,
      [workspaceId, formId],
    );
    if (!updated.rows[0]) return null;

    await tenant.query(
      `INSERT INTO app.audit_logs (id, workspace_id, actor, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'form.unpublished', 'form', $4, $5::jsonb)`,
      [uuidv7(), workspaceId, userId, formId, JSON.stringify({ formId })],
    );
    await tenant.query(
      `INSERT INTO app.outbox_events (id, event_type, payload)
       VALUES ($1, 'form.unpublished', $2::jsonb)`,
      [uuidv7(), JSON.stringify({ workspaceId, formId })],
    );

    return { formId, status: "closed" };
  }

  /**
   * Returns the form's current slug, allocating + registering one through the
   * security-definer `register_form_slug()` when the form has none yet. The
   * function re-enforces the 10-char base62 format, the reserved-word list,
   * and keeps any superseded slug as a redirect; a global collision (unique
   * violation 23505) retries with a fresh slug.
   */
  private async ensureCurrentSlug(
    tenant: TenantDb,
    workspaceId: string,
    formId: string,
  ): Promise<string> {
    const current = await tenant.query<{ slug: string }>(
      `SELECT slug FROM app.form_slugs
        WHERE workspace_id = $1 AND form_id = $2 AND is_current
        LIMIT 1`,
      [workspaceId, formId],
    );
    if (current.rows[0]) return current.rows[0].slug;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = generateSlug();
      try {
        await tenant.query(`SELECT app.register_form_slug($1::uuid, $2)`, [
          formId,
          slug,
        ]);
        return slug;
      } catch (error) {
        const code = (error as PublishError).code;
        if (code === "23505") continue; // global slug collision — retry
        throw error;
      }
    }
    throw new Error(`publish: could not allocate a free slug for form ${formId}`);
  }
}
