import { Inject, Injectable } from "@nestjs/common";
import type { Auth } from "@form/auth/server";
import type { AuthSession } from "@form/auth/client";

/** DI token for the DB-backed Better Auth instance created in app.ts. */
export const AUTH = Symbol("AUTH");

/**
 * Read-only session lookups shared by the session endpoint, the
 * email-unverified guard and (later tickets) route guards. Never creates
 * anything: a lookup with an invalid/absent cookie simply yields null.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  /**
   * Resolves the Better Auth session from the incoming Cookie header
   * (forwarded by SSR through the internal API URL, or attached by the
   * browser through the same-origin rewrite). Returns the minimal session
   * shape or null when the session is absent/invalid/expired/revoked.
   * The workspace stays null until ticket 05.
   */
  async getMinimalSession(cookieHeader?: string): Promise<AuthSession | null> {
    const headers = new Headers();
    if (cookieHeader) headers.set("cookie", cookieHeader);
    const result = await this.auth.api.getSession({ headers });
    if (!result?.user) return null;
    return {
      userId: result.user.id,
      email: result.user.email,
      emailVerified: result.user.emailVerified,
      // No workspace lookup on this path: the endpoint must never create or
      // resolve tenant data (ticket 05 introduces the active-workspace read).
      workspace: null,
    };
  }
}
