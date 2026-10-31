-- 0002_workspaces.sql — tenancy root (tickets 05).
--
-- Tables: workspaces, workspace_members, workspace_invitations, projects.
-- Every tenant table: app-side UUID PK, workspace_id NOT NULL (root link
-- workspace_id -> workspaces(id)), timestamps, soft delete, and a
-- UNIQUE (workspace_id, id) pair so child tables can build composite
-- foreign keys on it (spec: "Every tenant relationship uses a composite
-- foreign key on (workspace_id, parent_id) referencing a unique
-- (workspace_id, id) on the parent, except the root link to workspaces").
--
-- Forced RLS everywhere, policies with BOTH USING and WITH CHECK so a
-- contextless query matches no rows (nullif keeps an unset setting from
-- raising a cast error) and no UPDATE/INSERT can cross tenants.
--
-- Grant note: 0001's default privileges grant app_user full DML on tables
-- created by the migrator. The spec makes workspaces and workspace_members
-- reachable ONLY through the security-definer functions, so SELECT/INSERT/
-- UPDATE/DELETE are revoked from app_user here (fn_owner gets its own
-- grants with the functions in 0006).

DO $$
BEGIN
  CREATE TYPE app.workspace_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS app.workspaces (
  id          uuid PRIMARY KEY,              -- app-side UUIDv7 (ADR 0002)
  name        text NOT NULL,
  creator     uuid NOT NULL,                 -- Better Auth user id (uuid)
  is_personal boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- At most one personal workspace per user (spec/ticket 05).
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_personal_creator_uq
  ON app.workspaces (creator) WHERE is_personal AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app.workspace_members (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  user_id      uuid NOT NULL,
  role         app.workspace_role NOT NULL DEFAULT 'viewer',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT workspace_members_ws_user_uq UNIQUE (workspace_id, user_id),
  CONSTRAINT workspace_members_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON app.workspace_members (user_id);

CREATE TABLE IF NOT EXISTS app.workspace_invitations (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  email        text NOT NULL,
  role         app.workspace_role NOT NULL DEFAULT 'viewer',
  hashed_token text NOT NULL,
  expires_at   timestamptz NOT NULL,
  invited_by   uuid NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT workspace_invitations_ws_id_uq UNIQUE (workspace_id, id)
);

-- No UI or email flow in M0; the table exists with forced RLS only.

CREATE TABLE IF NOT EXISTS app.projects (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT projects_ws_id_uq UNIQUE (workspace_id, id)
);

-- The default project is found by flag, never by name (spec: data model).
CREATE UNIQUE INDEX IF NOT EXISTS projects_default_uq
  ON app.projects (workspace_id) WHERE is_default AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Forced RLS: enabled + forced (applies to the table owner too, so nothing
-- can lean on ownership), one FOR ALL policy per table carrying BOTH clauses.
-- `workspaces` is keyed by id; every other tenant table by workspace_id.
-- ---------------------------------------------------------------------------

ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_tenant_rls ON app.workspaces;
CREATE POLICY workspaces_tenant_rls ON app.workspaces
  TO app_user, worker_user
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_members_tenant_rls ON app.workspace_members;
CREATE POLICY workspace_members_tenant_rls ON app.workspace_members
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_invitations_tenant_rls ON app.workspace_invitations;
CREATE POLICY workspace_invitations_tenant_rls ON app.workspace_invitations
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_rls ON app.projects;
CREATE POLICY projects_tenant_rls ON app.projects
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants. Tenant tables keep the 0001 default DML for app_user/worker_user
-- (RLS is the boundary) EXCEPT workspaces and workspace_members, which the
-- spec restricts to the security-definer functions: no direct app_user grant.
-- ---------------------------------------------------------------------------

REVOKE ALL ON app.workspaces FROM app_user;
REVOKE ALL ON app.workspace_members FROM app_user;

GRANT SELECT ON app.workspaces TO worker_user;
GRANT SELECT ON app.workspace_members TO worker_user;
