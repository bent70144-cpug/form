import { Inject, Injectable } from "@nestjs/common";
import type { Auth } from "@form/auth/server";
import type { AuthSession, SessionWorkspace } from "@form/auth/client";
import type { Pool } from "pg";
import { withUserTransaction } from "@form/database";
import { APP_POOL } from "../workspaces/db";

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
    // Request-path tenant pool (app_user). Used ONLY for the read-only
    // workspace resolution below; the guard path never touches it.
    @Inject(APP_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Resolves the Better Auth session from the incoming Cookie header
   * (forwarded by SSR through the internal API URL, or attached by the
   * browser through the same-origin rewrite). Returns the minimal session
   * shape or null when the session is absent/invalid/expired/revoked.
   *
   * The workspace stays null here: the auth-guard path (email verification
   * boundary) runs on every classified route and must not pay for — or
   * depend on — a workspace lookup. Use `getMinimalSession(cookie, {
   * resolveWorkspace: true })` for the session endpoint.
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
      workspace: null,
    };
  }

  /**
   * `GET /v1/auth/session` shape (ticket 05): the minimal session PLUS the
   * active workspace {id, name, role} once one exists. The workspace is
   * resolved through the security-definer `list_workspaces()` in a READ-ONLY
   * narrow transaction (only `app.user_id` set) — the endpoint remains a
   * read-only GET that never creates or mutates anything. Before the first
   * bootstrap `workspace` is null.
   */
  async getSessionWithWorkspace(
    cookieHeader?: string,
  ): Promise<AuthSession | null> {
    const session = await this.getMinimalSession(cookieHeader);
    if (!session) return null;
    const listed = await withUserTransaction(this.pool, session.userId, (tx) =>
      tx.query<{ id: string; name: string; role: string }>(
        "SELECT id::text, name, role::text FROM app.list_workspaces()",
      ),
    );
    const row = listed.rows[0];
    const workspace: SessionWorkspace | null = row
      ? {
          id: row.id,
          name: row.name,
          role: row.role as SessionWorkspace["role"],
        }
      : null;
    return { ...session, workspace };
  }
}
