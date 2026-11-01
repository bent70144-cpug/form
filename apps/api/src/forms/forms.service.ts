import { Injectable } from "@nestjs/common";
import {
  emptyDraft,
  type FormSchema as DraftEnvelope,
} from "@form/form-schema";
import type {
  FormDetail,
  FormSummary,
  ListFormsRequest,
} from "@form/contracts";
import { t } from "@form/i18n";
import { uuidv7, type TenantDb } from "@form/database";

/**
 * Form domain service (ticket 06). Every method takes the `TenantDb` handle
 * the TenantContextInterceptor built (FULL workspace request context: the
 * transaction carries `app.user_id` AND `app.workspace_id`, set
 * transaction-locally after the workspace was resolved through the
 * security-definer `list_workspaces()`). RLS is the tenancy boundary: a form
 * of another workspace is simply not in the result set, which the controller
 * maps to 404 — never 403 (no enumeration). The service never opens its own
 * transaction: it runs strictly inside the interceptor's.
 *
 * Create is ONE transaction (the interceptor's): form row + form_drafts row
 * (empty envelope, `draft_version` 0) + the circular `current_draft_id`
 * pointer + the `form.created` audit row + the `form.created` outbox event.
 * A failure anywhere rolls all of it back (spec: "Every side effect that must
 * survive a crash is written to the outbox in the same transaction as the
 * domain change").
 *
 * The default project is found through `projects.is_default` — NEVER by
 * matching the name `General` (spec data model).
 *
 * NOTE: `app_user` has no SELECT grant on `outbox_events` (INSERT-only), so
 * the outbox insert uses no RETURNING (same pattern as the security-definer
 * bootstrap in migration 0006).
 */

const DEFAULT_NAME_KEY = "dashboard.forms.untitled";

interface FormRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface FormDetailRow extends FormRow {
  project_id: string;
  draft_version: number;
  draft_schema: unknown;
}

function iso(value: Date): string {
  return value.toISOString();
}

function toSummary(row: FormRow): FormSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status as FormSummary["status"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toDetail(row: FormDetailRow): FormDetail {
  return {
    ...toSummary(row),
    projectId: row.project_id,
    draft: {
      draftVersion: row.draft_version,
      schema: row.draft_schema as DraftEnvelope,
    },
  };
}

/** Opaque cursor: base64url of the keyset position `{ t, id }`. */
export function encodeCursor(position: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const t = (parsed as { t?: unknown }).t;
    const id = (parsed as { id?: unknown }).id;
    if (typeof t !== "string" || typeof id !== "string") return null;
    if (Number.isNaN(Date.parse(t))) return null;
    return { t, id };
  } catch {
    return null;
  }
}

@Injectable()
export class FormsService {
  /**
   * Creates the form + its draft row + audit + outbox inside the request's
   * tenant transaction. The dashboard label defaults to the i18n catalog's
   * "Untitled form" when the caller sends no name.
   */
  async create(
    tenant: TenantDb,
    userId: string,
    name?: string,
  ): Promise<FormDetail | "no_default_project"> {
    const workspaceId = tenant.context.workspaceId;

    // Default project BY FLAG (spec: "The default `General` project is found
    // by flag, never by name"). Oldest flagged project wins if several exist.
    const project = await tenant.query<{ id: string }>(
      `SELECT id::text FROM app.projects
        WHERE workspace_id = $1 AND is_default AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [workspaceId],
    );
    const projectId = project.rows[0]?.id;
    if (!projectId) return "no_default_project";

    const formId = uuidv7();
    const draftId = uuidv7();
    const formName = name ?? t(DEFAULT_NAME_KEY);
    const envelope: DraftEnvelope = emptyDraft();

    await tenant.query(
      `INSERT INTO app.forms (id, workspace_id, project_id, name, status, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5)`,
      [formId, workspaceId, projectId, formName, userId],
    );

    await tenant.query(
      `INSERT INTO app.form_drafts (id, workspace_id, form_id, schema, draft_version, last_edited_by)
       VALUES ($1, $2, $3, $4::jsonb, 0, $5)`,
      [draftId, workspaceId, formId, JSON.stringify(envelope), userId],
    );

    // Complete the circular pointer (composite FK on both sides).
    await tenant.query(
      `UPDATE app.forms SET current_draft_id = $2
        WHERE workspace_id = $1 AND id = $3`,
      [workspaceId, draftId, formId],
    );

    await tenant.query(
      `INSERT INTO app.audit_logs (id, workspace_id, actor, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'form.created', 'form', $4, $5::jsonb)`,
      [
        uuidv7(),
        workspaceId,
        userId,
        formId,
        JSON.stringify({ name: formName, projectId }),
      ],
    );

    // INSERT-only for app_user — no RETURNING (no SELECT grant on outbox).
    await tenant.query(
      `INSERT INTO app.outbox_events (id, event_type, payload)
       VALUES ($1, 'form.created', $2::jsonb)`,
      [uuidv7(), JSON.stringify({ workspaceId, formId, userId })],
    );

    const created = await tenant.query<FormDetailRow>(
      `SELECT f.id::text, f.name, f.status::text, f.project_id::text,
              f.created_at, f.updated_at,
              d.draft_version, d.schema AS draft_schema
         FROM app.forms f
         JOIN app.form_drafts d
           ON d.workspace_id = f.workspace_id AND d.form_id = f.id
        WHERE f.workspace_id = $1 AND f.id = $2 AND f.deleted_at IS NULL`,
      [workspaceId, formId],
    );
    return toDetail(created.rows[0]!);
  }

  /**
   * Cursor-paginated list, newest first by `(created_at, id)` (spec API
   * conventions; default page size 20, max 100 enforced by the request
   * contract). The `+1` fetch decides whether another page follows; the
   * cursor is the keyset position of the page's LAST returned row.
   */
  async list(
    tenant: TenantDb,
    page: ListFormsRequest,
  ): Promise<
    { forms: FormSummary[]; nextCursor: string | null } | "invalid_cursor"
  > {
    const workspaceId = tenant.context.workspaceId;
    const fetchLimit = page.limit + 1;

    let result;
    if (page.cursor === undefined) {
      result = await tenant.query<FormRow>(
        `SELECT f.id::text, f.name, f.status::text, f.created_at, f.updated_at
           FROM app.forms f
          WHERE f.workspace_id = $1 AND f.deleted_at IS NULL
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT $2`,
        [workspaceId, fetchLimit],
      );
    } else {
      const position = decodeCursor(page.cursor);
      if (!position) return "invalid_cursor";
      result = await tenant.query<FormRow>(
        `SELECT f.id::text, f.name, f.status::text, f.created_at, f.updated_at
           FROM app.forms f
          WHERE f.workspace_id = $1 AND f.deleted_at IS NULL
            AND (f.created_at, f.id) < ($2::timestamptz, $3::uuid)
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT $4`,
        [workspaceId, position.t, position.id, fetchLimit],
      );
    }

    const rows = result.rows;
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    return {
      forms: pageRows.map(toSummary),
      nextCursor: hasMore
        ? encodeCursor({
            t: pageRows[pageRows.length - 1]!.created_at.toISOString(),
            id: pageRows[pageRows.length - 1]!.id,
          })
        : null,
    };
  }

  /** Form + draft, or null when the row is missing/soft-deleted/foreign. */
  async getById(tenant: TenantDb, formId: string): Promise<FormDetail | null> {
    const result = await tenant.query<FormDetailRow>(
      `SELECT f.id::text, f.name, f.status::text, f.project_id::text,
              f.created_at, f.updated_at,
              d.draft_version, d.schema AS draft_schema
         FROM app.forms f
         JOIN app.form_drafts d
           ON d.workspace_id = f.workspace_id AND d.form_id = f.id
        WHERE f.workspace_id = $1 AND f.id = $2 AND f.deleted_at IS NULL`,
      [tenant.context.workspaceId, formId],
    );
    const row = result.rows[0];
    return row ? toDetail(row) : null;
  }

  /**
   * Renames the DASHBOARD label only (`forms.name`); the respondent-facing
   * title lives in the draft envelope and is untouched here. Returns null
   * when the form is missing or belongs to another workspace (→ 404).
   */
  async rename(
    tenant: TenantDb,
    formId: string,
    name: string,
  ): Promise<FormSummary | null> {
    const result = await tenant.query<FormRow>(
      `UPDATE app.forms f
          SET name = $3, updated_at = now()
        WHERE f.workspace_id = $1 AND f.id = $2 AND f.deleted_at IS NULL
        RETURNING f.id::text, f.name, f.status::text, f.created_at, f.updated_at`,
      [tenant.context.workspaceId, formId, name],
    );
    const row = result.rows[0];
    return row ? toSummary(row) : null;
  }
}
