import { Controller, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  publicFormPublishedSchema,
  sessionCreateResponseSchema,
  submitReceiptSchema,
  submitRequestSchema,
} from "@form/contracts";
import { sendProblem } from "../common/problem";
import { PublicSessionService } from "./public-session.service";
import { PublicSubmissionsService, SubmitProblemError } from "./public-submissions.service";

/**
 * Public INTERACTIVE controllers (ticket 10) — the cookie-less mutation half
 * of the public slice. Both routes are UNauthenticated (NO auth guard, NO
 * tenant interceptor) and sit on the explicit Origin-exempt allowlist in
 * common/origin-guard.ts:
 *
 *   POST /v1/public/forms/{slug}/sessions  — PublicFormSessionController
 *   POST /v1/public/submissions           — PublicSubmissionController
 *
 * Exempted routes must never read the auth cookie — and these never do: no
 * cookie parsing happens anywhere in this file, and the workspace context is
 * derived exclusively from the server-resolved form/session.
 *
 * EVERY response carries `Cache-Control: no-store` (M0 caching story).
 */

function noStore(res: Response): void {
  res.set("Cache-Control", "no-store");
}

/** Maps a SubmitProblemError onto the RFC 9457 problem writer. */
function sendSubmitProblem(res: Response, error: SubmitProblemError): void {
  sendProblem(res, error.status, error.code, {
    ...(error.issues
      ? {
          errors: error.issues.map((issue) => ({
            path: `answers.${issue.path}`,
            code: issue.code,
            message: issue.code, // i18n key: errors.schemaIssues.<code>
          })),
        }
      : {}),
  });
}

@Controller("public")
export class PublicFormSessionController {
  // Explicit @Inject — tsx (dev/smoke pipeline) does not emit decorator type
  // metadata (unlike the vitest SWC pipeline), so bare class-typed params
  // resolve to `undefined` at runtime (the ticket-12 smoke caught this).
  // Same pattern as every other controller in the codebase.
  constructor(
    @Inject(PublicSessionService)
    private readonly sessions: PublicSessionService,
  ) {}

  @Post("forms/:slug/sessions")
  @HttpCode(200)
  async createSession(
    @Param("slug") slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    noStore(res);

    const outcome = await this.sessions.createSession(slug, {
      headers: req.headers as Record<string, string | string[] | undefined>,
      remoteAddress: req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
    });

    if (!outcome.ok) {
      if (outcome.reason === "rate_limited") {
        const retryAfterSec = outcome.retryAfterSec ?? 1;
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
        sendProblem(res, 429, "rate_limited");
        return;
      }
      sendProblem(res, 404, "not_found");
      return;
    }

    const { session } = outcome;
    const payload = sessionCreateResponseSchema.parse({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      pinnedVersionId: session.pinnedVersionId,
      // Parse the pinned snapshot through the shared contract so the response
      // cannot drift (same shape the render path returns for `schema`).
      schema: publicFormPublishedSchema.shape.schema.parse(session.schema),
    });
    res.json(payload);
  }
}

@Controller("public")
export class PublicSubmissionController {
  // Explicit @Inject — same tsx decorator-metadata caveat as above.
  constructor(
    @Inject(PublicSubmissionsService)
    private readonly submissions: PublicSubmissionsService,
  ) {}

  @Post("submissions")
  @HttpCode(200)
  async submit(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    noStore(res);

    // The raw token rides in X-Form-Session (spec); missing → 401.
    const header = req.headers["x-form-session"];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== "string" || token.length === 0) {
      sendProblem(res, 401, "session_required");
      return;
    }

    // Contract parse: the body must be `{ answers: <object> }` (strict). A
    // missing/foreign envelope is 422 validation_failed with a stable
    // envelope error, BEFORE any DB work. Values stay unknown here — the
    // pinned-schema engine owns per-value validation (stable codes).
    const parsedBody = submitRequestSchema.safeParse(req.body ?? null);
    if (!parsedBody.success) {
      sendProblem(res, 422, "validation_failed", {
        errors: [{ path: "answers", code: "invalid_answer_type", message: "invalid_answer_type" }],
      });
      return;
    }

    try {
      const outcome = await this.submissions.submit(token, parsedBody.data.answers);
      const payload = submitReceiptSchema.parse(outcome.receipt);
      res.json(payload);
    } catch (error) {
      if (error instanceof SubmitProblemError) {
        sendSubmitProblem(res, error);
        return;
      }
      throw error;
    }
  }
}
