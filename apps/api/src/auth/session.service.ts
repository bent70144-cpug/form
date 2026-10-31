import { Inject, Injectable } from "@nestjs/common";
import type { Auth } from "@form/auth/server";
import type { AuthSession } from "@form/auth/client";
import { WorkspaceService } from "../workspaces/workspace.service";

/** DI token for the DB-backed Better Auth instance created in app.ts. */
export const AUTH = Symbol("AUTH");

/**
 * Read-only session lookups shared by the session endpoint, the
 * email-unverified guard and (later tickets) route guards. Never creates
 * anything: a lookup with an invalid/absent cookie simply yields null.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(WorkspaceService)
    private readonly workspaces: WorkspaceService,
  ) {}

  /**
   * Resolves the Better Auth session from the incoming Cookie header
   * (forwarded by SSR through the internal API URL, or attached by the
   * browser through the same-origin rewrite). Returns the minimal session
   * shape or null when the session is absent/invalid/expired/revoked.
   *
   * Ticket 05: the active workspace is populated for verified users by
   * reading the security-definer `list_workspaces()` with ONLY `app.user_id`
   * set (M0: the single personal workspace IS the active one). The endpoint
   * stays a read-only GET — it never creates or mutates a workspace;
   * unbootstrapped users simply get `workspace: null` and the dashboard
   * client component triggers the bootstrap.
   */
  async getMinimalSession(cookieHeader?: string): Promise<AuthSession | null> {
    const headers = new Headers();
    if (cookieHeader) headers.set("cookie", cookieHeader);
    const result = await this.auth.api.getSession({ headers });
    if (!result?.user) return null;

    // Unverified users cannot have workspaces (bootstrap requires a verified
    // email), so the tenant read is skipped entirely for them.
    const workspace = result.user.emailVerified
      ? await this.workspaces.resolveActiveWorkspace(result.user.id)
      : null;

    return {
      userId: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      workspace,
    };
  }
}
