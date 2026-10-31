// Import the v3 API explicitly: zod 3.25 ships v3+v4 in one package and
// zod-to-json-schema is typed against `zod/v3`. Mixing the root re-export with
// `zod/v3` types triggers a TS2589 instantiation explosion (OOM-scale check).
import { z } from "zod/v3";

/**
 * Workspace contracts (ticket 05). The active workspace is what
 * `GET /v1/auth/session` exposes once it exists and what
 * `POST /v1/workspaces/bootstrap` returns — the same shape the
 * security-definer `list_workspaces()` yields: id, display name, and the
 * CALLER'S membership role (owner in M0 — the API never accepts a role or
 * workspace id from the client).
 */
export const workspaceRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  role: z.enum(["owner", "admin", "editor", "viewer"]),
});

export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

/**
 * `POST /v1/workspaces/bootstrap` — idempotent. Request body is empty (the
 * caller is derived from the verified session); the response carries the
 * existing-or-newly-created personal workspace.
 */
export const bootstrapRequestSchema = z.object({}).strict();

export const bootstrapResponseSchema = z.object({
  workspace: workspaceRefSchema,
});

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/**
 * `GET /v1/auth/session` — the minimal read-only session (user ID, email,
 * verified flag, and the active workspace once it exists; the workspace is
 * null until bootstrap and the endpoint NEVER creates one). Mirrors
 * `@form/auth/client`'s AuthSession shape.
 */
export const sessionResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  workspace: workspaceRefSchema.nullable(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

