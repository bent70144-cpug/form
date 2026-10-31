import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "./email-verified.guard";
import type { AuthSession } from "@form/auth/client";

/**
 * Sample protected probe route used to test the reusable email-unverified
 * boundary BEFORE the real workspace/form/submission-management routes
 * arrive in T05+. Both routes require a verified email:
 * - GET  /v1/probe/verified  — 401 unauthenticated / 403 email_unverified / 200
 * - POST /v1/probe/verified  — additionally passes through the global Origin
 *   guard (state-changing method), proving the two layers compose.
 *
 * T05+ replaces this controller with the real guarded routes; the guard and
 * decorator themselves are the reusable deliverable.
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
  post(@CurrentSession() session: AuthSession | undefined) {
    return { ok: true, via: "POST", userId: session?.userId };
  }
}
