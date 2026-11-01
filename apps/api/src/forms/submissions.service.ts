import { Injectable } from "@nestjs/common";
import type { FormSchema } from "@form/form-schema";
import type {
  ListSubmissionsRequest,
  SubmissionDetail,
  SubmissionSummary,
} from "@form/contracts";
import type { TenantDb } from "@form/database";
import { decodeCursor, encodeCursor } from "./forms.service";

/**
 * Submission inbox service (ticket 11) — read-only per-form submission list
 * + detail for the DASHBOARD. Every method runs STRICTLY inside the request's
 * tenant transaction (the TenantRequestContextInterceptor opened it and set
 * `app.user_id` + `app.workspace_id` transaction-locally), so RLS is the
 * tenancy boundary: rows of another workspace are simply not in the result
 * set, which the controller maps to 404 — never 403 (no enumeration).
 *
 * List semantics (spec "API conventions"): cursor pagination, default page
 * size 20, maximum 100 (enforced by the request contract), ordered NEWEST
 * FIRST by `(created_at, id)` — the same keyset pattern as FormsService.list,
 * reusing its opaque base64url cursor. The `+1` fetch decides whether another
 * page follows; the cursor is the keyset position of the page's LAST row.
 *
 * Detail semantics: the stored answers are returned together with the PINNED
 * form version's immutable schema envelope so the UI pairs each answer with
 * its question label FROM THE VERSION THE RESPONDENT SAW — never the current
 * draft (a republish must not rewrite the history of old submissions).
 */

interface SubmissionRow {
  id: string;
  created_at: Date;
  form_version_id: string;
  version_number: number;
  /** jsonb answers keyed by block id (validated string values in M0). */
  answers: Record<string, string>;
}

interface SubmissionDetailRow extends SubmissionRow {
  version_schema: unknown;
}

/**
 * First text answer for the inbox preview, in a deterministic order (jsonb
 * object keys are stored sorted; any stable order makes a fine one-line
 * preview — the authoritative pairing happens on the detail page from the
 * pinned schema).
 */
export function firstAnswerPreview(
  answers: Record<string, unknown>,
): string | null {
  for (const value of Object.values(answers)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function toSummary(row: SubmissionRow): SubmissionSummary {
  return {
    id: row.id,
    submittedAt: row.created_at.toISOString(),
    formVersionId: row.form_version_id,
    formVersionNumber: row.version_number,
    preview: firstAnswerPreview(row.answers),
  };
}

const LIST_SELECT = `SELECT s.id::text, s.created_at, s.form_version_id::text,
              v.version_number, s.answers
         FROM app.submissions s
         JOIN app.form_versions v
           ON v.workspace_id = s.workspace_id AND v.id = s.form_version_id`;

const DETAIL_SELECT = `SELECT s.id::text, s.created_at, s.form_version_id::text,
              v.version_number, s.answers, v.schema AS version_schema
         FROM app.submissions s
         JOIN app.form_versions v
           ON v.workspace_id = s.workspace_id AND v.id = s.form_version_id`;

@Injectable()
export class SubmissionsService {
  /**
   * Whether the form exists in the ACTIVE workspace (RLS hides foreign rows,
   * soft-deleted rows are excluded). The list route answers 404 when this is
   * false — an unknown form never renders as an empty inbox.
   */
  async formExists(tenant: TenantDb, formId: string): Promise<boolean> {
    const result = await tenant.query<{ one: number }>(
      `SELECT 1 AS one FROM app.forms
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenant.context.workspaceId, formId],
    );
    return result.rows.length > 0;
  }

  /**
   * Cursor-paginated submission list for one form, newest first by
   * `(created_at, id)`. Returns null when the form does not exist in this
   * workspace (→ 404, never 403) and `"invalid_cursor"` for a malformed
   * cursor (→ 422, same as the forms list).
   */
  async list(
    tenant: TenantDb,
    formId: string,
    page: ListSubmissionsRequest,
  ): Promise<
    | { submissions: SubmissionSummary[]; nextCursor: string | null }
    | "invalid_cursor"
    | null
  > {
    const workspaceId = tenant.context.workspaceId;
    if (!(await this.formExists(tenant, formId))) return null;

    const fetchLimit = page.limit + 1;
    let result;
    if (page.cursor === undefined) {
      result = await tenant.query<SubmissionRow>(
        `${LIST_SELECT}
          WHERE s.workspace_id = $1 AND s.form_id = $2 AND s.deleted_at IS NULL
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $3`,
        [workspaceId, formId, fetchLimit],
      );
    } else {
      const position = decodeCursor(page.cursor);
      if (!position) return "invalid_cursor";
      result = await tenant.query<SubmissionRow>(
        `${LIST_SELECT}
          WHERE s.workspace_id = $1 AND s.form_id = $2 AND s.deleted_at IS NULL
            AND (s.created_at, s.id) < ($3::timestamptz, $4::uuid)
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $5`,
        [workspaceId, formId, position.t, position.id, fetchLimit],
      );
    }

    const rows = result.rows;
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    return {
      submissions: pageRows.map(toSummary),
      nextCursor: hasMore
        ? encodeCursor({
            t: pageRows[pageRows.length - 1]!.created_at.toISOString(),
            id: pageRows[pageRows.length - 1]!.id,
          })
        : null,
    };
  }

  /**
   * One submission + the PINNED version's schema. Returns null when the
   * submission does not exist under THIS form in THIS workspace (unknown id,
   * another form's submission id, another workspace's row — all 404).
   */
  async getDetail(
    tenant: TenantDb,
    formId: string,
    submissionId: string,
  ): Promise<SubmissionDetail | null> {
    const result = await tenant.query<SubmissionDetailRow>(
      `${DETAIL_SELECT}
          WHERE s.workspace_id = $1 AND s.form_id = $2
            AND s.id = $3 AND s.deleted_at IS NULL`,
      [tenant.context.workspaceId, formId, submissionId],
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      submission: {
        id: row.id,
        submittedAt: row.created_at.toISOString(),
        formVersion: {
          id: row.form_version_id,
          versionNumber: row.version_number,
        },
        answers: row.answers,
      },
      pinnedSchema: row.version_schema as FormSchema,
    };
  }
}
