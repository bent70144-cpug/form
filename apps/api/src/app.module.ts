import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { Auth } from "@form/auth/server";
import { RateLimiter } from "./common/rate-limit";
import { HealthController } from "./health.controller";
import { SessionController } from "./auth/session.controller";
import { VerifiedProbeController } from "./auth/probe.controller";
import { SessionService, AUTH } from "./auth/session.service";
import { EmailVerifiedGuard } from "./auth/email-verified.guard";

/**
 * Root NestJS module. Auth-dependent providers arrive through the
 * `withAuth` dynamic-module factory because the Better Auth instance is
 * built in createApiApp (it needs the caller-owned test pool and the
 * resolved email provider). The ticket-04 `RateLimiter` instance is created
 * in createApiApp too — the express-level rate-limit guard and any Nest
 * provider must share ONE process-wide instance — and handed over here as a
 * value provider (`RateLimitModule` remains available for standalone reuse).
 */
@Module({})
export class AppModule {
  static withAuth(auth: Auth, limiter: RateLimiter): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: AUTH, useValue: auth },
        { provide: RateLimiter, useValue: limiter },
        SessionService,
        EmailVerifiedGuard,
      ],
      controllers: [HealthController, SessionController, VerifiedProbeController],
    };
  }
}
