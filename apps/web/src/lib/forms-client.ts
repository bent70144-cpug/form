/**
 * Form mutation calls for the BROWSER (ticket 06) — the client-side half of
 * the dashboard form slices.
 *
 * Both mutations go through the SAME-ORIGIN `/v1/*` rewrite — never the
 * internal API URL — because the API's global Origin guard has no
 * internal-call exemption (same shape as lib/bootstrap-workspace.ts; server
 * components must NEVER import or call this module).
 *
 * - `createDashboardForm` POSTs `/v1/forms` (empty body: the server derives
 *   caller, workspace, default project and the default dashboard label) and
 *   returns the created form's id so the caller can navigate to
 *   /dashboard/forms/{id}.
 * - `renameDashboardForm` PATCHes `/v1/forms/{id}/name` — the DASHBOARD
 *   label (`forms.name`) only; the respondent-facing title lives in the
 *   draft envelope (builder, ticket 08).
 *
 * The `fetchImpl` seam keeps the wire behavior unit-testable without a
 * browser (same pattern as bootstrapWorkspace).
 */

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
    const res = await doFetch(`/v1/forms/${formId}/name`, {
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
