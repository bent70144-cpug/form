import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import type { ZodIssue } from "zod/v3";
import {
  listSubmissionsRequestSchema,
  type ListSubmissionsResponse,
} from "@form/contracts";
import { isUuid, type TenantDb } from "@form/database";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "../auth/email-verified.guard";
import { sendProblem } from "../common/problem";
import {
  RequireWorkspaceContext,
  TenantDbHandle,
  TenantRequestContextInterceptor,
} from "../workspaces/tenant-context.interceptor";
import { SubmissionsService } from "./submissions.service";

/**
 * Submission inbox routes (ticket 11) — the dashboard's read-only view of a
 * form's responses, wired exactly like FormsController (ticket 06): the
 * FULL tenant context (`EmailVerifiedGuard` → 401 `unauthenticated` /
 * 403 `email_unverified`; `TenantRequestContextInterceptor` → 403 `forbidden`
 * until bootstrapped, then the transaction carrying `app.user_id` +
 * `app.workspace_id`).
 *
 *   GET /v1/forms/{formId}/submissions                  list, cursor
 *                                                       pagination (default
 *                                                       20, max 100),
 *                                                       newest first by
 *                                                       (created_at, id)
 *   GET /v1/forms/{formId}/submissions/{submissionId}   detail: answers +
 *                                                       the PINNED version's
 *                                                       schema
 *
 * Unknown or cross-workspace forms/submissions answer 404 (never 403 — no
 * enumeration): RLS simply hides the other workspace's rows. A non-UUID path
 * parameter addresses nothing and must never reach a uuid-typed SQL cast, so
 * it 404s before any query (same as FormsController). CSV export and
 * analytics are NOT part of this slice (spec).
 */
@Controller("forms")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantRequestContextInterceptor)
export class SubmissionsController {
  constructor(
    // Explicit @Inject keeps constructor DI working in both the vitest/esbuild
    // pipeline and the tsc production build (same pattern as FormsController).
    @Inject(SubmissionsService)
    private readonly submissions: SubmissionsService,
  ) {}

  @Get(":formId/submissions")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async list(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const parsed = listSubmissionsRequestSchema.safeParse({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const page = await this.submissions.list(tenantDb!, formId, parsed.data);
    if (page === null) {
      sendProblem(res, 404, "not_found");
      return;
    }
    if (page === "invalid_cursor") {
      sendProblem(res, 422, "validation_failed", {
        errors: [
          { path: "cursor", code: "invalid", message: "Malformed cursor" },
        ],
      });
      return;
    }
    const payload: ListSubmissionsResponse = page;
    res.json(payload);
  }

  @Get(":formId/submissions/:submissionId")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async getDetail(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Param("submissionId") submissionId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(formId) || !isUuid(submissionId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const detail = await this.submissions.getDetail(
      tenantDb!,
      formId,
      submissionId,
    );
    if (!detail) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(detail);
  }

  /** Shared 422 writer (RFC 9457 + stable code + field errors). */
  private validationProblem(res: Response, issues: ZodIssue[]): void {
    sendProblem(res, 422, "validation_failed", {
      errors: issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}
