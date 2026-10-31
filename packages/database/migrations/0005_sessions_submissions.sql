-- 0005_sessions_submissions.sql — public respondent flow (ticket 10).
--
-- form_sessions: pinned to a published form version, keyed by the HASHED
-- session token (the raw token is returned once and never stored). Sessions
-- are usable 24h with a 5-minute submission grace; purge_expired_sessions()
-- removes them after 7 days.
-- submissions: one per session (UNIQUE form_session_id), answers JSONB,
-- soft delete. Composite FKs to forms/form_versions/form_sessions prevent
-- cross-tenant pinning.
--
-- Grant note: worker_user's ONLY access to form_sessions is the
-- security-definer purge_expired_sessions() — direct DML is revoked here
-- (0001 default privileges would otherwise grant it). app_user keeps DML
-- (create session, mark completed) with RLS as the boundary.

CREATE TABLE IF NOT EXISTS app.form_sessions (
  id               uuid PRIMARY KEY,       -- app-side UUIDv7 (ADR 0002)
  workspace_id     uuid NOT NULL REFERENCES app.workspaces(id),
  form_id          uuid NOT NULL,
  form_version_id  uuid NOT NULL,
  token_hash       text NOT NULL,          -- hash of the raw session token
  expires_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  ip_hash          text,                   -- HMAC of the trusted-proxy IP
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT form_sessions_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT form_sessions_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.submissions (
  id              uuid PRIMARY KEY,        -- app-side UUIDv7 (ADR 0002)
  workspace_id    uuid NOT NULL REFERENCES app.workspaces(id),
  form_id         uuid NOT NULL,
  form_version_id uuid NOT NULL,
  form_session_id uuid NOT NULL,
  answers         jsonb NOT NULL,          -- keyed by block id (strings in M0)
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT submissions_session_uq UNIQUE (form_session_id),
  CONSTRAINT submissions_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS form_sessions_ws_form_idx
  ON app.form_sessions (workspace_id, form_id);

-- Purge scan and expiry monitoring.
CREATE INDEX IF NOT EXISTS form_sessions_expires_idx
  ON app.form_sessions (expires_at);

-- Submission list: newest first by (created_at, id) per form (spec: API
-- conventions) under cursor pagination.
CREATE INDEX IF NOT EXISTS submissions_ws_form_created_idx
  ON app.submissions (workspace_id, form_id, created_at DESC, id DESC);

-- Composite tenant FKs.
ALTER TABLE app.form_sessions
  ADD CONSTRAINT form_sessions_form_composite_fk
  FOREIGN KEY (workspace_id, form_id) REFERENCES app.forms (workspace_id, id);

ALTER TABLE app.form_sessions
  ADD CONSTRAINT form_sessions_version_composite_fk
  FOREIGN KEY (workspace_id, form_version_id) REFERENCES app.form_versions (workspace_id, id);

ALTER TABLE app.submissions
  ADD CONSTRAINT submissions_form_composite_fk
  FOREIGN KEY (workspace_id, form_id) REFERENCES app.forms (workspace_id, id);

ALTER TABLE app.submissions
  ADD CONSTRAINT submissions_version_composite_fk
  FOREIGN KEY (workspace_id, form_version_id) REFERENCES app.form_versions (workspace_id, id);

ALTER TABLE app.submissions
  ADD CONSTRAINT submissions_session_composite_fk
  FOREIGN KEY (workspace_id, form_session_id) REFERENCES app.form_sessions (workspace_id, id);

-- ---------------------------------------------------------------------------
-- Forced RLS + both-clause policies (same pattern as 0002).
-- ---------------------------------------------------------------------------

ALTER TABLE app.form_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_sessions_tenant_rls ON app.form_sessions;
CREATE POLICY form_sessions_tenant_rls ON app.form_sessions
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS submissions_tenant_rls ON app.submissions;
CREATE POLICY submissions_tenant_rls ON app.submissions
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- worker_user reaches form_sessions only through purge_expired_sessions()
-- (0006); direct access is denied (42501), not merely filtered by RLS.
REVOKE ALL ON app.form_sessions FROM worker_user;
