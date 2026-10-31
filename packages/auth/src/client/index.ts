import { z } from "zod";

/**
 * @form/auth/client — shared session types + typed session client.
 * Importable by the web app and any package. Never touches the database.
 *
 * The real Better Auth wiring lands in tickets 02/03; the shape below is the
 * minimal session object the session endpoint will return (spec: "GET
 * /v1/auth/session returns a minimal object: user ID, email, verified flag,
 * and the active workspace ID, name, and role if one exists").
 */

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
});

export const sessionWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});

export const sessionSchema = z.object({
  user: sessionUserSchema,
  workspace: sessionWorkspaceSchema.nullable(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
export type SessionWorkspace = z.infer<typeof sessionWorkspaceSchema>;
export type AuthSession = z.infer<typeof sessionSchema>;

export interface SessionClientOptions {
  /** Internal API base URL, e.g. http://127.0.0.1:4000 (server components). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface SessionClient {
  /**
   * Fetch the current session. `cookieHeader` is forwarded by Next.js server
   * components; browser calls use the same-origin `/v1/*` rewrite instead.
   * Returns null on 401 (invalid/expired) — no error is thrown for signed-out
   * visitors.
   */
  getSession(cookieHeader?: string): Promise<AuthSession | null>;
}

export function createSessionClient(options: SessionClientOptions): SessionClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async getSession(cookieHeader?: string): Promise<AuthSession | null> {
      const headers: Record<string, string> = {};
      if (cookieHeader) headers["cookie"] = cookieHeader;
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, "")}/v1/auth/session`,
        { headers, cache: "no-store" },
      );
      if (response.status === 401) return null;
      if (!response.ok) {
        throw new Error(`Session endpoint failed: ${response.status}`);
      }
      return sessionSchema.parse(await response.json());
    },
  };
}
