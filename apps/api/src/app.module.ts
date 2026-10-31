import { DynamicModule, Module } from "@nestjs/common";
import type { Auth } from "@form/auth/server";
import { HealthController } from "./health.controller";
import { SessionController } from "./auth/session.controller";
import { VerifiedProbeController } from "./auth/probe.controller";
import { SessionService, AUTH } from "./auth/session.service";
import { EmailVerifiedGuard } from "./auth/email-verified.guard";

/**
 * Root NestJS module. Auth-dependent providers arrive through the
 * `withAuth` dynamic-module factory because the Better Auth instance is
 * built in createApiApp (it needs the caller-owned test pool and the
 * resolved email provider).
 */
@Module({})
export class AppModule {
  static withAuth(auth: Auth): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: AUTH, useValue: auth },
        SessionService,
        EmailVerifiedGuard,
      ],
      controllers: [HealthController, SessionController, VerifiedProbeController],
    };
  }
}
