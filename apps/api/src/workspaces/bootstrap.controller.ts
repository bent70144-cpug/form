import { Controller, HttpCode, Inject, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { AuthSession } from "@form/auth/client";
import { bootstrapResponseSchema } from "@form/contracts";
import { sendProblem } from "../common/problem";
import {
  CurrentSession,
  EmailVerifiedGuard,
  RequireVerifiedEmail,
} from "../auth/email-verified.guard";
import { WorkspaceService } from "./workspace.service";

/**
 * `POST /v1/workspaces/bootstrap` — the idempotent trigger for workspace
 * creation (spec: "Workspace creation is triggered by an idempotent
 * POST /v1/workspaces/bootstrap, which calls create_personal_workspace()
 * and returns the existing or newly created workspace").
 *
 * - Requires a VERIFIED email: 401 `unauthenticated` / 403
 *   `email_unverified` via the shared {@link EmailVerifiedGuard}.
 * - Mutation: the global Origin guard has NO exemption for this route —
 *   browser calls must come through the same-origin `/v1/*` rewrite with
 *   the app Origin. Bootstrap is NEVER called from server components.
 * - Runs with ONLY `app.user_id` set (narrower tenant context);
 *   `create_personal_workspace()` sets `app.workspace_id` internally.
 * - Repeated calls return the existing workspace without duplicate
 *   workspaces, memberships, projects, audit rows, or outbox events (the
 *   function is idempotent; the suite proves it over HTTP).
 */
@Controller("workspaces")
export class WorkspaceBootstrapController {
  constructor(
    @Inject(WorkspaceService)
    private readonly workspaces: WorkspaceService,
  ) {}

  @Post("bootstrap")
  @HttpCode(200)
  @RequireVerifiedEmail()
  @UseGuards(EmailVerifiedGuard)
  async bootstrap(
    @CurrentSession() session: AuthSession | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!session) {
      sendProblem(res, 401, "unauthenticated");
      return;
    }
    try {
      const workspace = await this.workspaces.bootstrapPersonal(session.userId);
      // Contract-validated response shape ({ workspace: { id, name, role } }).
      res.json(bootstrapResponseSchema.parse({ workspace }));
    } catch {
      // Security-definer failure (constraint, RLS, connection): a stable
      // 500 problem — no DB internals leak into the response.
      sendProblem(res, 500, "internal_error");
    }
  }
}
