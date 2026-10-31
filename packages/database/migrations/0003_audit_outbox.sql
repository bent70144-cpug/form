-- 0003_audit_outbox.sql — audit trail and transactional outbox (tickets 05/10).
--
-- audit_logs: tenant table, forced RLS, append-only (INSERT+SELECT for
-- app_user; NO UPDATE/DELETE for any non-owner role).
-- outbox_events: intentionally NOT a tenant table — no workspace_id column,
-- no RLS; the workspace id travels inside the JSONB payload. app_user gets
-- INSERT only (no SELECT), worker_user gets SELECT/UPDATE for the dispatcher.
--
-- NOTE FOR APPLICATION CODE: because app_user has no SELECT grant on
-- outbox_events, inserts MUST NOT use RETURNING (Drizzle's default
-- .returning() must be overridden/avoided on this table). Generate the id
-- app-side with uuidv7() and insert it explicitly.

CREATE TABLE IF NOT EXISTS app.audit_logs (
  id           uuid PRIMARY KEY,             -- app-side UUIDv7 (ADR 0002)
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),  -- root link
  actor        uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS audit_logs_ws_created_idx
  ON app.audit_logs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.outbox_events (
  id              uuid PRIMARY KEY,        -- app-side UUIDv7 (ADR 0002)
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,          -- carries workspace_id, not PII
  available_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz,
  processed_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  dead_lettered_at timestamptz
);

-- Dispatch scan: unprocessed, available events only.
CREATE INDEX IF NOT EXISTS outbox_events_dispatch_idx
  ON app.outbox_events (available_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- audit_logs: forced RLS with both clauses (same shape as the other
-- tenant tables).
ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_rls ON app.audit_logs;
CREATE POLICY audit_logs_tenant_rls ON app.audit_logs
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- audit_logs is append-only: INSERT + SELECT for the request role, nothing
-- else for any non-owner role (worker gets no audit access in M0).
REVOKE ALL ON app.audit_logs FROM app_user, worker_user;
GRANT INSERT, SELECT ON app.audit_logs TO app_user;

-- outbox_events: INSERT-only for the request role (no SELECT — inserts must
-- not use RETURNING), SELECT/UPDATE for the worker/dispatcher. No RLS: this
-- is not a tenant table, so no policy exists and the catalog guard skips it.
REVOKE ALL ON app.outbox_events FROM app_user, worker_user;
GRANT INSERT ON app.outbox_events TO app_user;
GRANT SELECT, UPDATE ON app.outbox_events TO worker_user;
