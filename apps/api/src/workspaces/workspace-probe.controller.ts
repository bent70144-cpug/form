import { Controller, Get, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "../auth/email-verified.guard";
import { WorkspaceRoute } from "./route-context";
import { TenantContextInterceptor, type TenantRequest } from "./tenant-interceptor";

/**
 * FULL-context probe route (test seam, mirroring ticket 03's
 * VerifiedProbeController pattern): proves the TenantContextInterceptor's
 * `workspace` classification end-to-end BEFORE the real workspace routes
 * (forms, T06) arrive. It only reports the request context the interceptor
 * built — no tenant data beyond the caller's own ids.
 *
 *   - unauthenticated → 401 (guard)
 *   - unverified email → 403 `email_unverified` (guard)
 *   - verified, no workspace → 403 `forbidden` (interceptor: nothing to
 *     activate; the dashboard bootstraps first)
 *   - verified with workspace → 200 { userId, workspaceId, workspaceSetting }
 *     where workspaceSetting re-reads `app.workspace_id` INSIDE the tenant
 *     transaction — the transaction-local value, visible only to this request
 *     (the pooled-connection leak test covers the reset).
 */
@Controller("probe")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantContextInterceptor)
export class WorkspaceProbeController {
  @RequireVerifiedEmail()
  @WorkspaceRoute()
  @Get("workspace")
  async workspace(
    @Req() req: TenantRequest,
    @CurrentSession() session: { userId: string } | undefined,
  ) {
    const tenant = req.tenantDb!;
    const setting = await tenant.query<{ wid: string | null }>(
      "SELECT current_setting('app.workspace_id', true) AS wid",
    );
    return {
      via: "workspace-context",
      userId: session?.userId ?? tenant.context.userId,
      workspaceId: tenant.context.workspaceId,
      // Proves the DB session actually carries the tenant setting.
      workspaceSetting: setting.rows[0]!.wid,
    };
  }
}
