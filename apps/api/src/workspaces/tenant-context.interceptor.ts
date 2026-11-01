import {
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EMPTY, from } from "rxjs";
import type { Observable } from "rxjs";
import { firstValueFrom } from "rxjs";
import type { Response } from "express";
import type { Pool } from "pg";
import { withTenantTransaction, type TenantDb } from "@form/database";
import type { AuthSession } from "@form/auth/client";
import { sendProblem } from "../common/problem";
import { t } from "@form/i18n";
import { APP_DB_POOL } from "../db/app-db";
import { WorkspaceService } from "./workspace.service";

/**
 * PRODUCTION tenant interceptor (registered globally in app.module.ts);
 * `tenant-interceptor.ts` keeps the probe-only variant used solely by
 * workspace-probe.controller.ts.
 *
 * Tenant request context (spec, "Tenancy and authorization": "A Nest
 * interceptor for authenticated workspace routes opens the transaction,
 * sets `app.user_id` from the verified session, resolves the user's active
 * workspace through the security-definer `list_workspaces()` (not a direct
 * RLS membership query), and sets `app.workspace_id` transaction-locally").
 *
 * Mechanics:
 * - Opt-in via the {@link RequireWorkspaceContext} marker, so auth/health/
 *   public/bootstrap routes keep their narrower context by simply not
 *   using it.
 * - The active workspace is resolved in a short transaction with ONLY
 *   `app.user_id` set (security-definer `list_workspaces()`); a 403
 *   `forbidden` problem with a stable setup detail is returned when the
 *   caller has no workspace yet (the dashboard bootstraps first).
 * - The HANDLER then runs inside `withTenantTransaction`, which sets BOTH
 *   `app.user_id` and `app.workspace_id` with `set_config(..., true)` —
 *   they vanish at COMMIT/ROLLBACK, so nothing leaks across pooled
 *   connections — and its `TenantDb` handle is attached to the request for
 *   controllers (ticket 06's forms controller just injects it via
 *   {@link TenantDbHandle}). The transaction commits when the handler
   * observable completes and rolls back on error.
 */
export const WORKSPACE_CONTEXT_KEY = "requireWorkspaceContext";

export const RequireWorkspaceContext = () =>
  SetMetadata(WORKSPACE_CONTEXT_KEY, true);

/** Injects the tenant transaction handle opened by the interceptor. */
export const TenantDbHandle = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantDb | undefined => {
    return context.switchToHttp().getRequest<TenantRequest>().tenantDb;
  },
);

/** Express request augmented by the session guard and this interceptor. */
export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  authSession?: AuthSession;
  tenantDb?: TenantDb;
}

@Injectable()
export class TenantRequestContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_DB_POOL) private readonly pool: Pool,
    @Inject(WorkspaceService) private readonly workspaces: WorkspaceService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const required = this.reflector.getAllAndOverride<boolean>(
      WORKSPACE_CONTEXT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<TenantRequest>();
    const res = http.getResponse<Response>();

    // The EmailVerifiedGuard runs BEFORE interceptors and attaches the
    // verified session; an absent session here is a wiring defect, but it
    // is still refused with the stable 401 problem.
    const session = req.authSession;
    if (!session?.userId) {
      sendProblem(res, 401, "unauthenticated");
      return EMPTY;
    }

    // Active workspace: resolved through list_workspaces() as app_user with
    // ONLY app.user_id set (never a direct RLS membership query, never a
    // client-supplied workspace ID).
    const workspace = await this.workspaces.resolveActiveWorkspace(
      session.userId,
    );
    if (!workspace) {
      // Authenticated + verified but not yet bootstrapped: the dashboard
      // client component calls POST /v1/workspaces/bootstrap first.
      sendProblem(res, 403, "forbidden", {
        detail: t("errors.workspaceSetup.detail"),
      });
      return EMPTY;
    }

    // The handler's transaction: app.user_id + app.workspace_id are set
    // transaction-locally (set_config true) and vanish at COMMIT/ROLLBACK.
    return from(
      withTenantTransaction(
        this.pool,
        { userId: session.userId, workspaceId: workspace.id },
        async (tx) => {
          req.tenantDb = tx;
          return await firstValueFrom(next.handle());
        },
      ),
    );
  }
}
