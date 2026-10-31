import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SessionService } from "./session.service";

/**
 * `GET /v1/auth/session` — the minimal read-only session endpoint
 * (spec: "returns the user ID, email, verified flag, and the active
 * workspace ID, name, and role when one exists; the workspace is null until
 * ticket 05. The endpoint is read-only and never creates a workspace").
 *
 * - Invalid/expired/revoked/absent session → 401 with an EMPTY body
 *   ("Invalid or expired sessions return 401 with no body detail").
 * - This route is deliberately carved out of the Better Auth mount (see
 *   AUTH_MOUNT.nestHandledPaths / mount.ts) and served by Nest so it can
 *   return the minimal contract instead of Better Auth's full payload.
 * - Safe method: the global Origin guard never applies, so SSR server
 *   components can call it directly on the internal API URL with only the
 *   forwarded cookie.
 */
@Controller("auth")
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get("session")
  async session(@Req() req: Request, @Res() res: Response): Promise<void> {
    const cookie = req.headers["cookie"];
    const session = await this.sessions.getMinimalSession(
      typeof cookie === "string" ? cookie : undefined,
    );
    if (!session) {
      res.status(401).end();
      return;
    }
    res.json(session);
  }
}
