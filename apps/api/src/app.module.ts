import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { Pool } from "pg";
import type { Auth } from "@form/auth/server";
import { RateLimiter } from "./common/rate-limit";
import { HealthController } from "./health.controller";
import { SessionController } from "./auth/session.controller";
import { VerifiedProbeController } from "./auth/probe.controller";
import { SessionService, AUTH } from "./auth/session.service";
import { EmailVerifiedGuard } from "./auth/email-verified.guard";
import { APP_DB_POOL } from "./db/app-db";
import { WorkspaceService } from "./workspaces/workspace.service";
import { WorkspaceBootstrapController } from "./workspaces/bootstrap.controller";
import { TenantRequestContextInterceptor } from "./workspaces/tenant-context.interceptor";
import { FormsService } from "./forms/forms.service";
import { FormsController } from "./forms/forms.controller";

/**
 * Root NestJS module. Auth-dependent providers arrive through the
 * `withAuth` dynamic-module factory because the Better Auth instance is
 * built in createApiApp (it needs the caller-owned test pool and the
 * resolved email provider). The ticket-04 `RateLimiter` instance is created
 * in createApiApp too — the express-level rate-limit guard and any Nest
 * provider must share ONE process-wide instance — and handed over here as a
 * value provider (`RateLimitModule` remains available for standalone reuse).
 *
 * Ticket 05 adds the pooled app_user tenant connection (`APP_DB_POOL`,
 * guarded via @form/database's createPool), the `WorkspaceService`
 * (security-definer bootstrap + active-workspace resolution), the
 * `POST /v1/workspaces/bootstrap` controller, and the
 * `TenantRequestContextInterceptor` (registered as a provider so
 * `@UseInterceptors(TenantRequestContextInterceptor)` resolves it with DI).
 *
 * Ticket 06 adds the first FULL-context domain routes: `FormsController`
 * (create/list/read/rename) with `FormsService` — every route carries
 * `@RequireWorkspaceContext()` and receives the interceptor's `TenantDb`.
 */
@Module({})
export class AppModule {
  static withAuth(auth: Auth, limiter: RateLimiter, dbPool: Pool): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: AUTH, useValue: auth },
        { provide: RateLimiter, useValue: limiter },
        { provide: APP_DB_POOL, useValue: dbPool },
        SessionService,
        EmailVerifiedGuard,
        WorkspaceService,
        TenantRequestContextInterceptor,
        FormsService,
      ],
      controllers: [
        HealthController,
        SessionController,
        VerifiedProbeController,
        WorkspaceBootstrapController,
        FormsController,
      ],
    };
  }
}
