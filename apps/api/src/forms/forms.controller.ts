import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import type { ZodIssue } from "zod/v3";
import {
  createFormRequestSchema,
  createFormResponseSchema,
  listFormsRequestSchema,
  renameFormRequestSchema,
  renameFormResponseSchema,
  type ListFormsResponse,
} from "@form/contracts";
import { isUuid, type TenantDb } from "@form/database";
import type { AuthSession } from "@form/auth/client";
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
import { FormsService } from "./forms.service";

/**
 * Forms routes (ticket 06) — the first FULL workspace-context domain routes
 * (spec "Tenancy and authorization": the interceptor opens the transaction,
 * resolves the active workspace through the security-definer
 * `list_workspaces()` and sets `app.workspace_id` transaction-locally):
 *
 *   POST   /v1/forms             create (active workspace + default project
 *                                by flag) — 201 with form + draft
 *   GET    /v1/forms             list, cursor pagination (default 20, max
 *                                100), newest first by (created_at, id)
 *   GET    /v1/forms/{id}        read form + draft (draftVersion + envelope)
 *   PATCH  /v1/forms/{id}/name   rename the DASHBOARD label only
 *
 * Every route requires a verified email (`EmailVerifiedGuard` — 401
 * `unauthenticated` / 403 `email_unverified`) and the FULL tenant context
 * (`TenantRequestContextInterceptor` — 403 `forbidden` with the stable
 * workspace-setup detail when nothing is bootstrapped yet). Unknown or
 * cross-workspace forms answer 404 (never 403 — no enumeration): the query
 * simply returns no row because RLS hides the other workspace's data.
 * Body/query validation failures are 422 `validation_failed` with field
 * errors; all problems are RFC 9457 bodies with i18n titles.
 */
@Controller("forms")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantRequestContextInterceptor)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  @HttpCode(201)
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async create(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @CurrentSession() session: AuthSession | undefined,
    @Res() res: Response,
    @Body() body?: unknown,
  ): Promise<void> {
    const parsed = createFormRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const detail = await this.forms.create(
      tenantDb!,
      session!.userId,
      parsed.data.name,
    );
    if (detail === "no_default_project") {
      // A workspace without a default project is a bootstrap invariant
      // violation, not a caller error — stable 500.
      sendProblem(res, 500, "internal_error");
      return;
    }
    // Parse through the shared contract so the response cannot drift.
    const payload = createFormResponseSchema.parse(detail);
    res.status(201).json(payload);
  }

  @Get()
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async list(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = listFormsRequestSchema.safeParse({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const page = await this.forms.list(tenantDb!, parsed.data);
    if (page === "invalid_cursor") {
      sendProblem(res, 422, "validation_failed", {
        errors: [
          { path: "cursor", code: "invalid", message: "Malformed cursor" },
        ],
      });
      return;
    }
    const payload: ListFormsResponse = page;
    res.json(payload);
  }

  @Get(":formId")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async getById(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
  ): Promise<void> {
    // A non-UUID path parameter addresses nothing (and must never reach a
    // uuid-typed SQL cast): 404 like any unknown form.
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const detail = await this.forms.getById(tenantDb!, formId);
    if (!detail) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(detail);
  }

  @Patch(":formId/name")
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async rename(
    @TenantDbHandle() tenantDb: TenantDb | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
    @Body() body?: unknown,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const parsed = renameFormRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.validationProblem(res, parsed.error.issues);
      return;
    }
    const summary = await this.forms.rename(
      tenantDb!,
      formId,
      parsed.data.name,
    );
    if (!summary) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(renameFormResponseSchema.parse(summary));
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
