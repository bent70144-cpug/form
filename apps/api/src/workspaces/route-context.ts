import { SetMetadata } from "@nestjs/common";

/**
 * Route classification for request contexts (ticket 05).
 *
 * The spec distinguishes HOW MUCH tenant machinery a route runs:
 *
 *   "workspace"  — FULL tenant context. A verified session is required; the
 *                  global TenantContextInterceptor opens a transaction, sets
 *                  `app.user_id` from the session, resolves the active
 *                  workspace through the security-definer
 *                  `list_workspaces()` (never a direct RLS membership query,
 *                  never a client-supplied id), sets `app.workspace_id`
 *                  transaction-locally, and exposes the `TenantDb` handle to
 *                  the controller. Every authenticated workspace route
 *                  (forms, projects, submissions-management — T06+) uses this.
 *
 *   "user"       — NARROW bootstrap context. A verified session is required,
 *                  but the transaction sets ONLY `app.user_id`: there is no
 *                  workspace to activate yet, RLS hides every tenant row, and
 *                  the route may only act through security-definer functions
 *                  (`create_personal_workspace()`), which set
 *                  `app.workspace_id` transaction-locally themselves.
 *                  Used by `POST /v1/workspaces/bootstrap`.
 *
 *   unclassified — NO tenant machinery at all. Health, OpenAPI, the Better
 *                  Auth mount and `GET /v1/auth/session` stay here: the
 *                  session endpoint resolves the workspace through a
 *                  read-only user-only transaction inside SessionService and
 *                  NEVER writes (it is a plain GET, exempt from the Origin
 *                  guard), and public/cookie-less routes never read tenant
 *                  data.
 *
 * The interceptor is registered globally but exits immediately for routes
 * without a marker (the same metadata-marker pattern as EmailVerifiedGuard).
 */
export const ROUTE_CONTEXT_KEY = "routeContext";

export type RouteContext = "user" | "workspace";

export const UserContextRoute = () => SetMetadata(ROUTE_CONTEXT_KEY, "user");

export const WorkspaceRoute = () =>
  SetMetadata(ROUTE_CONTEXT_KEY, "workspace");
