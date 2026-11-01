import {
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import {
  publishResponseSchema,
  unpublishResponseSchema,
} from "@form/contracts";
import { isUuid } from "@form/database";
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
import { schemaIssueMessage } from "./forms.controller";
import { PublishService } from "./publish.service";

/**
 * Publish routes (ticket 09) — everything behind the dashboard's Publish /
 * Republish / Unpublish controls (the buttons themselves land with ticket
 * 08's builder UI):
 *
 *   POST /v1/forms/{formId}/publish    ONE transaction → immutable version,
 *                                      status `published`, slug on first
 *                                      publish, audit + outbox. 200 with the
 *                                      PublishResponse (version + slug +
 *                                      worst-case size warning numbers);
 *                                      422 with the engine's stable codes and
 *                                      NOTHING persisted on validation
 *                                      failures; 404 for unknown/foreign
 *                                      forms (RLS hides them — no
 *                                      enumeration).
 *   POST /v1/forms/{formId}/unpublish  status `closed` + audit + outbox; 200.
 *
 * Both are mutations: verified email (`EmailVerifiedGuard`), the FULL tenant
 * context (`TenantRequestContextInterceptor` opens the transaction the
 * service runs inside), and a same-origin Origin header (global guard) are
 * required. Republish = publish again → a NEW immutable version; the slug is
 * kept. Unpublish → `closed`; republishing reopens the form.
 */
@Controller("forms")
@UseGuards(EmailVerifiedGuard)
@UseInterceptors(TenantRequestContextInterceptor)
export class PublishController {
  constructor(
    @Inject(PublishService) private readonly publishService: PublishService,
  ) {}

  @Post(":formId/publish")
  @HttpCode(200)
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async publish(
    @TenantDbHandle() tenantDb: Parameters<PublishService["publish"]>[0] | undefined,
    @CurrentSession() session: AuthSession | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const outcome = await this.publishService.publish(
      tenantDb!,
      formId,
      session!.userId,
    );
    if (outcome === null) {
      sendProblem(res, 404, "not_found");
      return;
    }
    if (!outcome.ok) {
      sendProblem(res, 422, "validation_failed", {
        errors: outcome.issues.map((issue) => ({
          path: issue.path || "(root)",
          code: issue.code,
          message: schemaIssueMessage(issue.code),
        })),
      });
      return;
    }
    // Parse through the shared contract so the response cannot drift.
    res.json(publishResponseSchema.parse(outcome.response));
  }

  @Post(":formId/unpublish")
  @HttpCode(200)
  @RequireVerifiedEmail()
  @RequireWorkspaceContext()
  async unpublish(
    @TenantDbHandle() tenantDb: Parameters<PublishService["unpublish"]>[0] | undefined,
    @CurrentSession() session: AuthSession | undefined,
    @Param("formId") formId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(formId)) {
      sendProblem(res, 404, "not_found");
      return;
    }
    const summary = await this.publishService.unpublish(
      tenantDb!,
      formId,
      session!.userId,
    );
    if (summary === null) {
      sendProblem(res, 404, "not_found");
      return;
    }
    res.json(unpublishResponseSchema.parse(summary));
  }
}
