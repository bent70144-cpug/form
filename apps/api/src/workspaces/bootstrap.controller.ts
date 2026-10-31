import {
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import {
  bootstrapResponseSchema,
  type BootstrapResponse,
} from "@form/contracts";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "../auth/email-verified.guard";
import { UserContextRoute } from "./route-context";
import { TenantContextInterceptor } from "./tenant-interceptor";
import { WorkspaceService } from "./workspace.service";

/**
 * `POST /v1/workspaces/bootstrap` — the ONLY trigger for workspace creation
 * (spec). Idempotent: the first call creates the personal workspace, owner
 * membership, and default General project (plus the `workspace.created` audit
 * row and outbox event, written by the security-definer function in the same
 * transaction); repeated calls return the existing workspace and duplicate
 * nothing.
 *
 * Request context (route classification, see route-context.ts): NARROW —
 * verified session required, but the transaction sets ONLY `app.user_id`.
 * The workspace does not exist yet, so no interceptor workspace resolution
 * happens and `app.workspace_id` is set inside `create_personal_workspace()`
 * itself. The global Origin guard applies (state-changing POST through the
 * browser's same-origin /v1/* rewrite — there is NO internal-call exemption),
 * which is exactly why bootstrap is never called from a server component.
 */
@Controller("workspaces")
@UseInterceptors(TenantContextInterceptor)
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Post("bootstrap")
  @HttpCode(200)
  @RequireVerifiedEmail()
  @UseGuards(EmailVerifiedGuard)
  @UserContextRoute()
  async bootstrap(
    @CurrentSession() session: { userId: string } | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const workspace = await this.workspaces.bootstrap(session!.userId);
    // Parse through the shared contract so the response cannot drift.
    const body = bootstrapResponseSchema.parse({ workspace });
    res.json(body satisfies BootstrapResponse);
  }
}
