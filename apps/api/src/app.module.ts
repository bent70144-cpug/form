import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { Auth } from "@form/auth/server";
import type { Pool } from "pg";
import { RateLimiter } from "./common/rate-limit";
import { HealthController } from "./health.controller";
import { SessionController } from "./auth/session.controller";
import { VerifiedProbeController } from "./auth/probe.controller";
import { SessionService, AUTH } from "./auth/session.service";
import { EmailVerifiedGuard } from "./auth/email-verified.guard";
import { APP_POOL } from "./workspaces/db";
import { TenantContextInterceptor } from "./workspaces/tenant-interceptor";
import { WorkspaceService } from "./workspaces/workspace.service";
import { WorkspaceController } from "./workspaces/bootstrap.controller";
import { WorkspaceProbeController } from "./workspaces/workspace-probe.controller";

/**
 * Root NestJS module. Auth-dependent providers arrive through the
 * `withAuth` dynamic-module factory because the Better Auth instance is
 * built in createApiApp (it needs the caller-owned test pool and the
 * resolved email provider); the request-path tenant pool is built alongside
 * it (pooled app_user URL — see workspaces/db.ts). The ticket-04 `RateLimiter`
 * instance is created in createApiApp too — the express-level rate-limit
 * guard and any Nest provider must share ONE process-wide instance.
 *
 * Route classification (workspaces/route-context.ts): health, OpenAPI, the
 * Better Auth mount and `GET /v1/auth/session` run with NO tenant machinery;
 * `POST /v1/workspaces/bootstrap` runs the NARROW user-only context; the
 * TenantContextInterceptor is registered globally but only engages for
 * routes carrying the `@UserContextRoute()` / `@WorkspaceRoute()` markers.
 */
@Module({})
export class AppModule {
  static withAuth(auth: Auth, appPool: Pool, limiter: RateLimiter): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: AUTH, useValue: auth },
        { provide: APP_POOL, useValue: appPool },
        { provide: RateLimiter, useValue: limiter },
        SessionService,
        EmailVerifiedGuard,
        WorkspaceService,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
      controllers: [
        HealthController,
        SessionController,
        VerifiedProbeController,
        WorkspaceController,
        WorkspaceProbeController,
      ],
    };
  }
}
