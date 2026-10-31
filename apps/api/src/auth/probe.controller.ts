import { Controller, Get, HttpCode, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "./email-verified.guard";
import {
  RequireWorkspaceContext,
  TenantDbHandle,
  TenantRequestContextInterceptor,
} from "../workspaces/tenant-context.interceptor";
import type { TenantDb } from "@form/database";
import type { AuthSession } from "@form/auth/client";

/**
 * Protected probe routes used to test the reusable boundaries BEFORE the
 * real workspace/form/submission-management routes take over:
 * - GET  /v1/probe/verified         — 401 unauthenticated / 403 email_unverified / 200
 * - POST /v1/probe/verified         — additionally passes through the global Origin
 *                                     guard (state-changing method), proving the two layers compose.
 * - GET  /v1/probe/workspace-context — the ticket-05 tenant request context:
 *                                     the interceptor opens the tenant transaction, sets
 *                                     `app.user_id` + `app.workspace_id` transaction-locally,
 *                                     and hands the handler a `TenantDb`; the route echoes the
 *                                     transaction-local settings (read via current_setting) and
 *                                     the `list_workspaces()` rows visible inside it.
 */
@Controller("probe")
@UseGuards(EmailVerifiedGuard)
export class VerifiedProbeController {
  @RequireVerifiedEmail()
  @Get("verified")
  get(@CurrentSession() session: AuthSession | undefined) {
    return { ok: true, via: "GET", userId: session?.userId };
  }

  @RequireVerifiedEmail()
  @Post("verified")
  @HttpCode(200)
  post(@CurrentSession() session: AuthSession | undefined) {
    return { ok: true, via: "POST", userId: session?.userId };
  }

  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  @UseInterceptors(TenantRequestContextInterceptor)
  @Get("workspace-context")
  async workspaceContext(
    @CurrentSession() session: AuthSession | undefined,
    @TenantDbHandle() tenantDb: TenantDb | undefined,
  ) {
    if (!tenantDb) {
      return { ok: false, reason: "tenant handle missing (interceptor not wired)" };
    }
    const probe = await tenantDb.query<{
      tenant_user_id: string;
      tenant_workspace_id: string;
      workspaces: Array<{ id: string; name: string; role: string }>;
    }>(
      `SELECT current_setting('app.user_id', true) AS tenant_user_id,
              current_setting('app.workspace_id', true) AS tenant_workspace_id,
              COALESCE(
                (SELECT jsonb_agg(to_jsonb(w)) FROM app.list_workspaces() w),
                '[]'::jsonb
              ) AS workspaces`,
    );
    const row = probe.rows[0];
    return {
      ok: true,
      sessionUserId: session?.userId ?? null,
      tenant: {
        userId: row?.tenant_user_id ?? "",
        workspaceId: row?.tenant_workspace_id ?? "",
        workspaces: row?.workspaces ?? [],
      },
    };
  }
}
