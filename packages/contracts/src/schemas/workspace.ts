import { z } from "zod/v3";

/**
 * Workspace contracts (ticket 05). The bootstrap response shape is the
 * single source of truth for `POST /v1/workspaces/bootstrap` and matches
 * the `@form/auth/client` session workspace (`{ id, name, role }`) — the
 * role enum is the `app.workspace_role` DB enum (spec: "Roles are owner,
 * admin, editor, and viewer").
 */
export const workspaceRoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  role: workspaceRoleSchema,
});

/**
 * `POST /v1/workspaces/bootstrap` — idempotent; returns the existing or
 * newly created personal workspace with the caller's membership role.
 */
export const bootstrapResponseSchema = z.object({
  workspace: workspaceSchema,
});

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/**
 * `GET /v1/auth/session` — the minimal session object (spec: "user ID, email,
 * verified flag, and the active workspace ID, name, and role if one exists").
 * Read-only; the workspace is null until ticket 05's bootstrap succeeds.
 */
export const sessionResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  workspace: workspaceSchema.nullable(),
});

/**
 * `POST /v1/workspaces/bootstrap` request — empty by contract: the caller is
 * derived from the verified session, never from the body.
 */
export const bootstrapRequestSchema = z.object({}).strict();
