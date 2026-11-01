/**
 * Form mutation calls for the BROWSER (tickets 06 + 07) — the client-side
 * half of the dashboard form slices.
 *
 * All mutations go through the SAME-ORIGIN `/v1/*` rewrite — never the
 * internal API URL — because the API's global Origin guard has no
 * internal-call exemption (same shape as lib/bootstrap-workspace.ts; server
 * components must NEVER import or call this module).
 *
 * - `createDashboardForm` POSTs `/v1/forms` (empty body: the server derives
 *   caller, workspace, default project and the default dashboard label) and
 *   returns the created form's id so the caller can navigate to
 *   /dashboard/forms/{id}.
 * - `renameDashboardForm` PATCHes `/v1/forms/{id}` — the DASHBOARD
 *   label (`forms.name`) only; the respondent-facing title lives in the
 *   draft envelope (builder, ticket 08).
 * - `saveDraftForm` PUTs `/v1/forms/{id}/draft` (ticket 07): the FULL draft
 *   envelope plus the last-seen `draftVersion`. The pre-flight check reuses
 *   the SHARED `@form/form-schema` engine (spec: "The web app consumes the
 *   shared schema and contract types; it does not duplicate validation
 *   rules") — the server stays authoritative and re-validates on save. A
 *   409 maps to `conflict` (another tab saved first); success returns the
 *   NEW draft version parsed through the shared contract.
 *
 * The `fetchImpl` seam keeps the wire behavior unit-testable without a
 * browser (same pattern as bootstrapWorkspace).
 */

import {
  draftSaveRequestSchema,
  draftSaveResponseSchema,
  type FormDraftSchema,
} from "@form/contracts";
import { validateDraftSchema } from "@form/form-schema";

export interface CreatedForm {
  ok: boolean;
  formId: string | null;
}

export async function createDashboardForm(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CreatedForm> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch("/v1/forms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({}),
    });
    if (!res.ok) return { ok: false, formId: null };
    const body = (await res.json()) as { id?: unknown };
    return {
      ok: true,
      formId: typeof body.id === "string" ? body.id : null,
    };
  } catch {
    return { ok: false, formId: null };
  }
}

export async function renameDashboardForm(
  formId: string,
  name: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`/v1/forms/${formId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Outcome of a draft save (ticket 07). */
export type SaveDraftOutcome =
  | { ok: true; draftVersion: number }
  | { ok: false; reason: "invalid_draft" | "conflict" | "failed" };

/**
 * Saves the FULL draft schema (ticket 07) — `PUT /v1/forms/{id}/draft` with
 * the last-seen `draftVersion`. Pre-flights the envelope through the SHARED
 * `@form/form-schema` engine so a structurally invalid draft never leaves
 * the browser (the server re-validates authoritatively); a 409
 * `draft_conflict` (another tab saved first) maps to `conflict`; success
 * returns the NEW draft version parsed through the shared contract.
 */
export async function saveDraftForm(
  formId: string,
  draft: { draftVersion: number; schema: FormDraftSchema },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SaveDraftOutcome> {
  if (!validateDraftSchema(draft.schema).ok) {
    return { ok: false, reason: "invalid_draft" };
  }
  const parsed = draftSaveRequestSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_draft" };
  }
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(
      `/v1/forms/${encodeURIComponent(formId)}/draft`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(parsed.data),
      },
    );
    if (res.status === 409) return { ok: false, reason: "conflict" };
    if (!res.ok) return { ok: false, reason: "failed" };
    const body = draftSaveResponseSchema.safeParse(await res.json());
    return body.success
      ? { ok: true, draftVersion: body.data.draftVersion }
      : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
