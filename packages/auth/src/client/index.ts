import { z } from "zod";

/**
 * @form/auth/client — shared session types + typed session client.
 * Importable by the web app and any package. Never touches the database.
 *
 * The session shape is the `GET /v1/auth/session` contract (spec: "returns a
 * minimal object: user ID, email, verified flag, and the active workspace
 * ID, name, and role if one exists"). The workspace stays `null` until
 * ticket 05 (workspace bootstrap) — the endpoint never creates one.
 */

export const sessionWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});

export const sessionSchema = z.object({
  userId: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  workspace: sessionWorkspaceSchema.nullable(),
});

export type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>;
export type AuthSession = z.infer<typeof sessionSchema>;

export interface SessionClientOptions {
  /**
   * API base URL. Server components pass the INTERNAL API URL
   * (API_INTERNAL_URL) so the call never traverses the public domain;
   * browser callers omit it and hit the same-origin `/v1/*` rewrite
   * (relative URL).
   */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SessionClient {
  /**
   * Fetch the current session. `cookieHeader` is forwarded by Next.js server
   * components; browser calls rely on the browser attaching cookies itself
   * through the same-origin rewrite. Returns null on 401 (invalid/expired) —
   * no error is thrown for signed-out visitors.
   */
  getSession(cookieHeader?: string): Promise<AuthSession | null>;
}

export function createSessionClient(options: SessionClientOptions = {}): SessionClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  return {
    async getSession(cookieHeader?: string): Promise<AuthSession | null> {
      const headers: Record<string, string> = {};
      if (cookieHeader) headers["cookie"] = cookieHeader;
      const response = await fetchImpl(
        `${base}/v1/auth/session`,
        // No `cache` option: Node fetch (undici) keeps responses uncached by
        // default and its RequestInit type does not declare `cache`.
        { headers },
      );
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Session endpoint failed: ${response.status}`);
      }
      return sessionSchema.parse(await response.json());
    },
  };
}
