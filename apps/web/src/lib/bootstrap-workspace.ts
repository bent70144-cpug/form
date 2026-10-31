/**
 * Workspace bootstrap call for the browser (ticket 05).
 *
 * POSTs the idempotent `POST /v1/workspaces/bootstrap` through the
 * SAME-ORIGIN `/v1/*` rewrite — never the internal API URL. The browser's
 * automatic Origin header on cross-allowed POSTs satisfies the API's global
 * Origin guard (no internal-call exemption exists), and SameSite=Lax cookies
 * ride along via `credentials: "same-origin"`.
 *
 * This module is browser-only glue: server components must NEVER import or
 * call it — workspace creation happens only from the dashboard's client
 * component when `GET /v1/auth/session` reports `workspace: null`.
 */
export async function bootstrapWorkspace(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch("/v1/workspaces/bootstrap", {
    method: "POST",
    credentials: "same-origin",
  });
  return res.ok;
}
