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
import {
  listSubmissionsRequestSchema,
  type ListSubmissionsResponse,
} from "@form/contracts";
import { isUuid } from "@form/database";
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
import type { TenantDb } from "@form/database";
import { SubmissionsService } from "./submissions.service";

/**
 * Submission inbox routes (ticket 11) — the dashboard's read side of the
 * ticket-10 submissions, over the SAME FULL workspace context as the forms
 * routes (verified email + TenantRequestContextInterceptor):
 *
 *   GET /v1/forms/{formId}/submissions               cursor-paginated inbox
 *                                                    page (newest first by
 *                                                    (created_at, id),
 *                                                    default 20 / max 100)
 *   GET /v1/forms/{formId}/submissions/{sid}         detail: each answer
 *                                                    paired with its label
 *                                                    FROM THE PINNED
 *                                                    VERSION's schema
 *
 * Unknown or cross-workspace forms/submissions answer 404 (never 403 — no
 * enumeration): RLS hides the other workspace's rows. Non-UUID path
 * parameters address nothing and 404 before any SQL cast. Invalid
 * `limit`/`cursor` values are 422 `validation_failed` with field errors.
 */
@Controller("forms")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantRequestContextInterceptor)
export class SubmissionsController {
  constructor(
    @Inject(SubmissionsService) private readonly submissions: SubmissionsService,
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
      sendProblem(res, 422, "validation_failed", {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          code: issue.code,
          message: issue.message,
        })),
      });
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
}
