import { Injectable } from "@nestjs/common";
import type {
  ListSubmissionsRequest,
  ListSubmissionsResponse,
  SubmissionDetail,
  SubmissionSummary,
} from "@form/contracts";
import type { TenantDb } from "@form/database";
import { decodeCursor, encodeCursor } from "./forms.service";

/**
 * Submission inbox service (ticket 11) — the dashboard's read side of the
 * `app.submissions` rows the public submit transaction wrote (ticket 10).
 *
 * Every method runs strictly inside the TenantRequestContextInterceptor's
 * tenant transaction (app.user_id + app.workspace_id set transaction-locally;
 * forced RLS is the tenancy boundary): a submission or form of another
 * workspace is simply not in the result set, which the controller maps to
 * 404 — never 403 (no enumeration).
 *
 * - `list` is cursor-paginated newest-first by `(created_at, id)` (spec API
 *   conventions; default 20 / max 100 enforced by the request contract),
 *   after verifying the FORM exists in this workspace (so a foreign form
 *   answers 404 rather than an empty page).
 * - `getDetail` pairs EACH stored answer with its question label taken from
 *   the PINNED version's schema (`form_versions.schema` — the version the
 *   respondent actually saw, never the mutable draft), in pinned-block
 *   order, plus the received time and the form version number. Labels and
 *   answers travel as plain text; the web app renders them escaped.
 */

interface SubmissionRow {
  id: string;
  created_at: Date;
  form_version_id: string;
  answers: unknown;
}

interface VersionRow {
  version_number: number;
  schema: unknown;
}

/** Question-block kinds that accept answers (the M0 union). */
function isQuestionBlock(block: unknown): block is { id: string; label?: unknown } {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as { kind?: unknown; id?: unknown };
  return (
    (candidate.kind === "short_text" || candidate.kind === "long_text") &&
    typeof candidate.id === "string"
  );
}

@Injectable()
export class SubmissionsService {
  /**
   * One inbox page for the form (404-mapped by the controller when the form
   * itself does not exist in this workspace). Newest first by
   * `(created_at, id)`; the cursor is the keyset position of the page's
   * LAST returned row (same opaque base64url shape as the forms list).
   */
  async list(
    tenant: TenantDb,
    formId: string,
    page: ListSubmissionsRequest,
  ): Promise<ListSubmissionsResponse | "invalid_cursor" | null> {
    const workspaceId = tenant.context.workspaceId;

    // The form must exist here (unknown OR cross-workspace → 404 upstream);
    // an existing form with no submissions is a valid empty page.
    const form = await tenant.query<{ one: number }>(
      `SELECT 1 AS one FROM app.forms
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [workspaceId, formId],
    );
    if (!form.rows[0]) return null;

    const fetchLimit = page.limit + 1;
    const select = `SELECT s.id::text, s.created_at, s.form_version_id::text,
                s.answers
           FROM app.submissions s
          WHERE s.workspace_id = $1 AND s.form_id = $2
            AND s.deleted_at IS NULL`;
    let result;
    if (page.cursor === undefined) {
      result = await tenant.query<SubmissionRow>(
        `${select}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $3`,
        [workspaceId, formId, fetchLimit],
      );
    } else {
      const position = decodeCursor(page.cursor);
      if (!position) return "invalid_cursor";
      result = await tenant.query<SubmissionRow>(
        `${select}
            AND (s.created_at, s.id) < ($3::timestamptz, $4::uuid)
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $5`,
        [workspaceId, formId, position.t, position.id, fetchLimit],
      );
    }

    // Version numbers for the page's rows (single round trip).
    const versionNumbers = await this.versionNumbersFor(
      tenant,
      result.rows.map((row) => row.form_version_id),
    );

    const rows = result.rows;
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    const summaries: SubmissionSummary[] = pageRows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      formVersionNumber: versionNumbers.get(row.form_version_id) ?? 0,
    }));
    return {
      submissions: summaries,
      nextCursor: hasMore
        ? encodeCursor({
            t: pageRows[pageRows.length - 1]!.created_at.toISOString(),
            id: pageRows[pageRows.length - 1]!.id,
          })
        : null,
    };
  }

  /**
   * The detail view: submission + pinned-version pairing. Returns null when
   * the submission does not exist IN THIS FORM AND WORKSPACE (unknown,
   * cross-form, or cross-workspace → 404 upstream, never 403).
   */
  async getDetail(
    tenant: TenantDb,
    formId: string,
    submissionId: string,
  ): Promise<SubmissionDetail | null> {
    const workspaceId = tenant.context.workspaceId;

    // The form must exist here too: a submission id addressed under a
    // foreign (or unknown) form path is a 404, matching the list route.
    const form = await tenant.query<{ one: number }>(
      `SELECT 1 AS one FROM app.forms
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [workspaceId, formId],
    );
    if (!form.rows[0]) return null;

    const found = await tenant.query<SubmissionRow>(
      `SELECT s.id::text, s.created_at, s.form_version_id::text, s.answers
         FROM app.submissions s
        WHERE s.workspace_id = $1 AND s.form_id = $2 AND s.id = $3
          AND s.deleted_at IS NULL`,
      [workspaceId, formId, submissionId],
    );
    const submission = found.rows[0];
    if (!submission) return null;

    // The PINNED version's schema is the label source (not the draft).
    const version = await tenant.query<VersionRow>(
      `SELECT v.version_number, v.schema
         FROM app.form_versions v
        WHERE v.workspace_id = $1 AND v.id = $2`,
      [workspaceId, submission.form_version_id],
    );
    const versionRow = version.rows[0];
    if (!versionRow) return null; // Defensive: FK guarantees existence.

    return {
      id: submission.id,
      createdAt: submission.created_at.toISOString(),
      formVersionNumber: versionRow.version_number,
      answers: this.pairAnswers(versionRow.schema, submission.answers),
    };
  }

  /**
   * Pairs each stored answer with its question label in PINNED-block order;
   * answer keys that reference no question block in the pinned schema
   * (defensive — the pinned version is immutable) keep their stored answer
   * with a null label so nothing the respondent typed silently disappears.
   */
  private pairAnswers(pinnedSchema: unknown, storedAnswers: unknown): SubmissionDetail["answers"] {
    const answers =
      typeof storedAnswers === "object" && storedAnswers !== null && !Array.isArray(storedAnswers)
        ? (storedAnswers as Record<string, unknown>)
        : {};
    const blocks = Array.isArray(
      (pinnedSchema as { blocks?: unknown } | null)?.blocks,
    )
      ? ((pinnedSchema as { blocks: unknown[] }).blocks)
      : [];

    const pairs: SubmissionDetail["answers"] = [];
    const covered = new Set<string>();
    for (const block of blocks) {
      if (!isQuestionBlock(block)) continue;
      covered.add(block.id);
      const raw = answers[block.id];
      if (raw === undefined) continue;
      pairs.push({
        blockId: block.id,
        label: typeof block.label === "string" ? block.label : null,
        answer: typeof raw === "string" ? raw : JSON.stringify(raw),
      });
    }
    for (const [blockId, raw] of Object.entries(answers)) {
      if (covered.has(blockId)) continue;
      pairs.push({
        blockId,
        label: null,
        answer: typeof raw === "string" ? raw : JSON.stringify(raw),
      });
    }
    return pairs;
  }

  /** version_number per pinned-version id for one page (one round trip). */
  private async versionNumbersFor(
    tenant: TenantDb,
    versionIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (versionIds.length === 0) return map;
    const rows = await tenant.query<{ id: string; version_number: number }>(
      `SELECT v.id::text, v.version_number
         FROM app.form_versions v
        WHERE v.workspace_id = $1
          AND v.id = ANY($2::uuid[])`,
      [tenant.context.workspaceId, versionIds],
    );
    for (const row of rows.rows) map.set(row.id, row.version_number);
    return map;
  }
}
