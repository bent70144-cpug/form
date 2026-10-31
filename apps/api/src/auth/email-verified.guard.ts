import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
  Inject,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import type { Auth } from "@form/auth/server";
import type { AuthSession } from "@form/auth/client";
import { sendProblem } from "../common/problem";
import { AUTH } from "./session.service";

/**
 * Reusable email-verification boundary (spec: "Unverified users may sign in,
 * but bootstrap, workspace, form, and submission-management routes return
 * 403 `email_unverified`").
 *
 * Usage on any controller/route (routes arrive in T05+):
 *   @RequireVerifiedEmail()
 *   @UseGuards(EmailVerifiedGuard)
 *
 * The guard checks the metadata marker first, so it is safe to bind globally
 * later; a route without the marker is not affected. Signed-out requests get
 * 401 `unauthenticated`; signed-in-but-unverified requests get 403
 * `email_unverified` — both as RFC 9457 problem bodies with i18n titles.
 */
export const REQUIRE_VERIFIED_EMAIL_KEY = "requireVerifiedEmail";

export const RequireVerifiedEmail = () =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL_KEY, true);

/** Injects the resolved minimal session (available after the guard passes). */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthSession | undefined => {
    return context.switchToHttp().getRequest<{ authSession?: AuthSession }>()
      .authSession;
  },
);

/** Request augmented with the resolved minimal session after the guard passes. */
interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  authSession?: AuthSession;
}

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  // Explicit @Inject for BOTH params: vitest/esbuild does not emit
  // `design:paramtypes` (tsc production build does) — self-declared deps
  // keep constructor DI working in both pipelines.
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_VERIFIED_EMAIL_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    const res = http.getResponse<Response>();

    const headers = new Headers();
    const cookie = req.headers["cookie"];
    if (typeof cookie === "string") headers.set("cookie", cookie);
    const result = await this.auth.api.getSession({ headers });

    if (!result?.user) {
      sendProblem(res, 401, "unauthenticated");
      return false;
    }
    if (!result.user.emailVerified) {
      sendProblem(res, 403, "email_unverified");
      return false;
    }
    req.authSession = {
      userId: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      workspace: null,
    };
    return true;
  }
}
