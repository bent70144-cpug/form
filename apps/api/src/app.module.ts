import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { Pool } from "pg";
import type { Auth } from "@form/auth/server";
import { RateLimiter } from "./common/rate-limit";
import type { TrustedIpConfig } from "./common/trusted-ip";
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
import { SubmissionsService } from "./forms/submissions.service";
import { SubmissionsController } from "./forms/submissions.controller";
import { PublishService } from "./forms/publish.service";
import { PublishController } from "./forms/publish.controller";
import { PublicFormController } from "./public/public.controller";
import { PublicSessionService } from "./public/public-session.service";
import { PublicSubmissionsService } from "./public/public-submissions.service";
import {
  PublicFormSessionController,
  PublicSubmissionController,
} from "./public/public-session.controller";

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
 *
 * Ticket 09 adds the publish slice: `PublishController` (POST publish /
 * unpublish — same FULL workspace context as FormsController) with
 * `PublishService` (one transaction: row lock, full publish validation,
 * immutable version, slug registration, audit + outbox), and the
 * UNauthenticated `PublicFormController` (GET /v1/public/forms/{slug} wrapping
 * the security-definer `get_published_form()` on the raw pool — no guards, no
 * tenant transaction, `Cache-Control: no-store` on every response).
 */
@Module({})
export class AppModule {
  /** Values the ticket-10 public services need from the process env/config. */
  static withAuth(
    auth: Auth,
    limiter: RateLimiter,
    dbPool: Pool,
    publicConfig: {
      /** Trusted-proxy config for the public session rate-limit keys. */
      trustedIpConfig: TrustedIpConfig;
      /** HMAC key for the stored session ip_hash (server secret). */
      ipHashSecret: string;
      /** Per-form submission cap enforced on the submit route. */
      submissionCap: number;
    },
  ): DynamicModule {
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
        SubmissionsService,
        PublishService,
        PublicSessionService,
        PublicSubmissionsService,
        { provide: "PUBLIC_TRUSTED_IP_CONFIG", useValue: publicConfig.trustedIpConfig },
        { provide: "PUBLIC_IP_HASH_SECRET", useValue: publicConfig.ipHashSecret },
        { provide: "PUBLIC_SUBMISSION_CAP", useValue: publicConfig.submissionCap },
      ],
      controllers: [
        HealthController,
        SessionController,
        VerifiedProbeController,
        WorkspaceBootstrapController,
        FormsController,
        SubmissionsController,
        PublishController,
        PublicFormController,
        PublicFormSessionController,
        PublicSubmissionController,
      ],
    };
  }
}
