import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EMPTY, firstValueFrom, of, type Observable } from "rxjs";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { withUserTransaction, type TenantDb, type UserDb } from "@form/database";
import { sendProblem } from "../common/problem";
import { APP_POOL } from "./db";
import { ROUTE_CONTEXT_KEY, type RouteContext } from "./route-context";

/**
 * Request shape after the interceptor ran (explicit type — no module
 * augmentation): classified routes receive `userDb` (narrow) or `tenantDb`
 * (full) through the request object.
 */
export type TenantRequest = Request & {
  authSession?: { userId: string };
  /** NARROW context (user-only transaction) — `user`-classified routes. */
  userDb?: UserDb;
  /** FULL tenant context — `workspace`-classified routes. */
  tenantDb?: TenantDb;
};

/**
 * PROBE-ONLY tenant interceptor: used solely by workspace-probe.controller.ts
 * (test seam); production routes use `tenant-context.interceptor.ts`'s
 * `TenantRequestContextInterceptor` (registered globally in app.module.ts).
 *
 * Global interceptor for classified tenant routes (see route-context.ts for
 * the full/narrow/unclassified contract).
 *
 * Guards run BEFORE interceptors, so `req.authSession` (set by
 * EmailVerifiedGuard) is already populated here. For a `user` route the whole
 * handler runs inside a transaction with ONLY `app.user_id` set; for a
 * `workspace` route the same transaction resolves the active workspace via
 * the security-definer `list_workspaces()` and sets `app.workspace_id`
 * transaction-locally before the controller sees the TenantDb handle. The
 * response is materialized with `firstValueFrom` so the controller's promise
 * completes before COMMIT (a controller error rolls the whole request back).
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const classification =
      this.reflector.getAllAndOverride<RouteContext | undefined>(
        ROUTE_CONTEXT_KEY,
        [context.getHandler(), context.getClass()],
      );
    if (!classification) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<TenantRequest>();
    const res = http.getResponse<Response>();

    const session = req.authSession;
    if (!session) {
      // Defensive: classified routes also carry RequireVerifiedEmail +
      // EmailVerifiedGuard, which answers 401 first.
      sendProblem(res, 401, "unauthenticated");
      return EMPTY;
    }

    if (classification === "user") {
      // NARROW: only app.user_id. Bootstrap calls the security-definer
      // create_personal_workspace(), which sets app.workspace_id internally
      // once the workspace exists.
      const result = await withUserTransaction(
        this.pool,
        session.userId,
        async (tx) => {
          req.userDb = tx;
          return firstValueFrom(next.handle());
        },
      );
      return of(result);
    }

    // FULL: resolve the active workspace inside the user-only transaction —
    // list_workspaces() reads app.user_id, never a client-supplied id, and
    // is NOT a direct RLS membership query (spec requirement).
    const result = await withUserTransaction(
      this.pool,
      session.userId,
      async (tx) => {
        const listed = await tx.query<{
          id: string;
          name: string;
          role: string;
        }>("SELECT id::text, name, role::text FROM app.list_workspaces()");
        const workspace = listed.rows[0];
        if (!workspace) {
          // No workspace yet: the dashboard's client bootstrap component owns
          // creating it; hitting a workspace route first is a client
          // sequencing error. 403 (not 404 — no resource was addressed).
          sendProblem(res, 403, "forbidden");
          return undefined;
        }
        req.tenantDb = await tx.withWorkspace(workspace.id);
        return firstValueFrom(next.handle());
      },
    );
    if (result === undefined) return EMPTY;
    return of(result);
  }
}
