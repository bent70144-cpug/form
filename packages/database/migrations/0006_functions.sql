-- 0006_functions.sql — security-definer seam (tickets 05/06/09/10 DB slice).
--
-- Every function:
-- - runs with SECURITY DEFINER as the dedicated NOLOGIN `fn_owner` role
--   (which has NO BYPASSRLS), so RLS always applies and function-scoped
--   `TO fn_owner` policies below are the ONLY widened access;
-- - pins `SET search_path = app, pg_temp`;
-- - revokes EXECUTE from PUBLIC and grants it only to its caller role
--   (app_user on the request path, worker_user for the purge job).
--
-- Ownership: functions are created under `SET LOCAL ROLE fn_owner` (migrator
-- holds fn_owner WITH ADMIN OPTION per the admin bootstrap — see
-- src/bootstrap.ts), so they are owned by fn_owner from birth. Postgres
-- requires a function's owner to hold CREATE on its schema, so this file
-- grants CREATE on `app` to fn_owner transiently and revokes it again at the
-- bottom — fn_owner ends with zero DDL privileges.
--
-- fn_owner policies (both USING and WITH CHECK everywhere):
-- - workspaces / workspace_members / projects / audit_logs: tenant-shaped
--   (id or workspace_id vs app.workspace_id, membership fallback on the
--   workspaces USING side for list_workspaces' bootstrap lookup);
-- - forms / form_versions / form_slugs / form_sessions: read-any (public
--   resolution filters by slug/hash across tenants), write gated to the
--   active workspace. No form_drafts grant exists at all — functions
--   structurally cannot read drafts.

GRANT CREATE ON SCHEMA app TO fn_owner;  -- transient, revoked at the end

-- ---------------------------------------------------------------------------
-- fn_owner table grants (tables owned by the migrator)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON app.workspaces TO fn_owner;
GRANT SELECT, INSERT ON app.workspace_members TO fn_owner;
GRANT SELECT, INSERT ON app.projects TO fn_owner;
GRANT INSERT, SELECT ON app.audit_logs TO fn_owner;
GRANT INSERT ON app.outbox_events TO fn_owner;
GRANT SELECT, UPDATE, INSERT ON app.form_slugs TO fn_owner;
GRANT SELECT ON app.forms TO fn_owner;
GRANT SELECT ON app.form_versions TO fn_owner;
GRANT SELECT, DELETE ON app.form_sessions TO fn_owner;

-- ---------------------------------------------------------------------------
-- fn_owner RLS policies (both clauses; separate from the app_user policies)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS workspaces_fn_owner ON app.workspaces;
CREATE POLICY workspaces_fn_owner ON app.workspaces
  FOR ALL TO fn_owner
  USING (
    id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR EXISTS (
      SELECT 1
      FROM app.workspace_members m
      WHERE m.workspace_id = app.workspaces.id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS workspace_members_fn_owner ON app.workspace_members;
CREATE POLICY workspace_members_fn_owner ON app.workspace_members
  FOR ALL TO fn_owner
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );

DROP POLICY IF EXISTS projects_fn_owner ON app.projects;
CREATE POLICY projects_fn_owner ON app.projects
  FOR ALL TO fn_owner
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS audit_logs_fn_owner ON app.audit_logs;
CREATE POLICY audit_logs_fn_owner ON app.audit_logs
  FOR ALL TO fn_owner
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Public read path: functions may read published forms, versions, and slugs
-- across tenants and filter by slug; writes stay tenant-gated.
DROP POLICY IF EXISTS forms_fn_owner ON app.forms;
CREATE POLICY forms_fn_owner ON app.forms
  FOR ALL TO fn_owner
  USING (true)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS form_versions_fn_owner ON app.form_versions;
CREATE POLICY form_versions_fn_owner ON app.form_versions
  FOR ALL TO fn_owner
  USING (true)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS form_slugs_fn_owner ON app.form_slugs;
CREATE POLICY form_slugs_fn_owner ON app.form_slugs
  FOR ALL TO fn_owner
  USING (true)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- resolve_form_session() resolves by token hash before any tenant context
-- exists; purge_expired_sessions() deletes across tenants by design.
DROP POLICY IF EXISTS form_sessions_fn_owner ON app.form_sessions;
CREATE POLICY form_sessions_fn_owner ON app.form_sessions
  FOR ALL TO fn_owner
  USING (true)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Functions — created AS fn_owner (via SET LOCAL ROLE), so they are owned by
-- fn_owner without any later ALTER OWNER step.
-- ---------------------------------------------------------------------------

SET LOCAL ROLE fn_owner;

CREATE OR REPLACE FUNCTION app.list_workspaces()
RETURNS TABLE (id uuid, name text, role app.workspace_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  -- Reads app.user_id from the transaction, never a caller-supplied id.
  -- Output columns are shadowed by the qualified table aliases below.
  SELECT w.id, w.name, m.role
  FROM app.workspace_members m
  JOIN app.workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND m.deleted_at IS NULL
    AND w.deleted_at IS NULL
$fn$;

CREATE OR REPLACE FUNCTION app.create_personal_workspace()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_user      uuid;
  v_existing  uuid;
  v_workspace uuid;
BEGIN
  v_user := nullif(current_setting('app.user_id', true), '')::uuid;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'create_personal_workspace: app.user_id is not set';
  END IF;

  -- Idempotency: the user's existing personal workspace wins. This path
  -- writes NO duplicate audit row and NO duplicate outbox event.
  SELECT w.id INTO v_existing
  FROM app.workspaces w
  WHERE w.creator = v_user
    AND w.is_personal
    AND w.deleted_at IS NULL
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- ADR 0002 prefers app-side uuidv7; gen_random_uuid() here is the
  -- documented server-side exception for the SQL-only bootstrap path.
  v_workspace := gen_random_uuid();

  -- Set the tenant context BEFORE the inserts so the fn_owner WITH CHECK
  -- clauses pass (fn_owner has no BYPASSRLS; forced RLS binds its owner too).
  PERFORM set_config('app.workspace_id', v_workspace::text, true);

  INSERT INTO app.workspaces (id, name, creator, is_personal)
  VALUES (v_workspace, 'Personal Workspace', v_user, true);

  INSERT INTO app.workspace_members (id, workspace_id, user_id, role)
  VALUES (gen_random_uuid(), v_workspace, v_user, 'owner');

  INSERT INTO app.projects (id, workspace_id, name, is_default)
  VALUES (gen_random_uuid(), v_workspace, 'General', true);

  INSERT INTO app.audit_logs (id, workspace_id, actor, action)
  VALUES (gen_random_uuid(), v_workspace, v_user, 'workspace.created');

  -- Outbox: the workspace id travels in the payload (no workspace_id column).
  INSERT INTO app.outbox_events (id, event_type, payload)
  VALUES (
    gen_random_uuid(),
    'workspace.created',
    jsonb_build_object('workspaceId', v_workspace, 'userId', v_user)
  );

  RETURN v_workspace;
END;
$fn$;

CREATE OR REPLACE FUNCTION app.get_published_form(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_slug_row      app.form_slugs%ROWTYPE;
  v_form          app.forms%ROWTYPE;
  v_canonical     text;
  v_version       app.form_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_slug_row FROM app.form_slugs s WHERE s.slug = p_slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT * INTO v_form
  FROM app.forms f
  WHERE f.workspace_id = v_slug_row.workspace_id
    AND f.id = v_slug_row.form_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Superseded slugs redirect to the form's current one.
  IF v_slug_row.is_current = false THEN
    SELECT s.slug INTO v_canonical
    FROM app.form_slugs s
    WHERE s.workspace_id = v_form.workspace_id
      AND s.form_id = v_form.id
      AND s.is_current
    LIMIT 1;
    RETURN jsonb_build_object(
      'status', 'redirect',
      'canonicalSlug', v_canonical,
      'formId', v_form.id,
      'workspaceId', v_form.workspace_id
    );
  END IF;

  -- Soft-deleted, closed, or never-published forms all read as closed —
  -- a respondent sees the closed message, not a generic 404. Drafts are
  -- structurally unreachable: this function never touches form_drafts.
  IF v_form.deleted_at IS NOT NULL
     OR v_form.status <> 'published'
     OR v_form.published_version_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'closed',
      'formId', v_form.id,
      'workspaceId', v_form.workspace_id
    );
  END IF;

  SELECT * INTO v_version
  FROM app.form_versions v
  WHERE v.workspace_id = v_form.workspace_id
    AND v.id = v_form.published_version_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'closed',
      'formId', v_form.id,
      'workspaceId', v_form.workspace_id
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'published',
    'formId', v_form.id,
    'workspaceId', v_form.workspace_id,
    'versionId', v_version.id,
    'versionNumber', v_version.version_number,
    'schema', v_version."schema"
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.resolve_public_form(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  -- Session-creation path: ids and pinning metadata only, current slug,
  -- published and non-deleted forms; NULL otherwise. Never drafts.
  SELECT jsonb_build_object(
    'formId', f.id,
    'workspaceId', f.workspace_id,
    'versionId', v.id,
    'versionNumber', v.version_number,
    'schema', v."schema",
    'slug', s.slug
  )
  FROM app.form_slugs s
  JOIN app.forms f
    ON f.workspace_id = s.workspace_id AND f.id = s.form_id
  JOIN app.form_versions v
    ON v.workspace_id = f.workspace_id AND v.id = f.published_version_id
  WHERE s.slug = p_slug
    AND s.is_current
    AND f.status = 'published'
    AND f.deleted_at IS NULL
$fn$;

CREATE OR REPLACE FUNCTION app.register_form_slug(p_form_id uuid, p_slug text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_workspace uuid;
BEGIN
  -- Reserved route names can never become slugs (checked before the format
  -- so the stable rejection reason is "reserved", not "malformed").
  IF p_slug = ANY (ARRAY[
    'admin', 'api', 'app', 'auth', 'dashboard', 'f', 'health', 'login',
    'logout', 'openapi', 'public', 'settings', 'signup', 'signin', 'static',
    'v1', 'www'
  ]) THEN
    RAISE EXCEPTION 'slug_reserved: % collides with an application route', p_slug
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  IF p_slug !~ '^[A-Za-z0-9]{10}$' THEN
    RAISE EXCEPTION 'slug_invalid_format: % must be 10 base62 characters', p_slug
      USING ERRCODE = '23514';
  END IF;

  -- The form MUST belong to the caller's active workspace (app.workspace_id).
  SELECT f.workspace_id INTO v_workspace
  FROM app.forms f
  WHERE f.id = p_form_id
    AND f.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND f.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'form_not_found: % is not a form of the active workspace', p_form_id
      USING ERRCODE = 'P0002'; -- no_data_found
  END IF;

  -- Supersede the previous current slug: it stays in the registry as a
  -- redirect target resolved by get_published_form().
  UPDATE app.form_slugs s
  SET is_current = false,
      updated_at = now()
  WHERE s.workspace_id = v_workspace
    AND s.form_id = p_form_id
    AND s.is_current;

  INSERT INTO app.form_slugs (id, workspace_id, form_id, slug, is_current)
  VALUES (gen_random_uuid(), v_workspace, p_form_id, p_slug, true);
  -- Global slug collisions raise the natural unique violation (23505).
END;
$fn$;

CREATE OR REPLACE FUNCTION app.resolve_form_session(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_session        app.form_sessions%ROWTYPE;
  v_form           app.forms%ROWTYPE;
  v_version_number integer;
  v_state          text;
BEGIN
  SELECT * INTO v_session
  FROM app.form_sessions s
  WHERE s.token_hash = p_token_hash
    AND s.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_form
  FROM app.forms f
  WHERE f.workspace_id = v_session.workspace_id
    AND f.id = v_session.form_id;

  SELECT v.version_number INTO v_version_number
  FROM app.form_versions v
  WHERE v.workspace_id = v_session.workspace_id
    AND v.id = v_session.form_version_id;

  -- 24-hour usability window, 5-minute acceptance grace (spec).
  IF now() < v_session.expires_at THEN
    v_state := 'usable';
  ELSIF now() < v_session.expires_at + interval '5 minutes' THEN
    v_state := 'within_grace';
  ELSE
    v_state := 'expired_beyond_grace';
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'workspaceId', v_session.workspace_id,
    'formId', v_session.form_id,
    'formVersionId', v_session.form_version_id,
    'versionNumber', v_version_number,
    'state', v_state,
    'completed', v_session.completed_at IS NOT NULL,
    'expiresAt', v_session.expires_at,
    'formStatus', v_form.status,
    'formDeleted', (v_form.deleted_at IS NOT NULL OR v_form.id IS NULL)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.purge_expired_sessions()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- The worker's ONLY cross-tenant access to form_sessions (spec). Sessions
  -- expired for more than seven days are gone; anything within the window
  -- stays (including the 5-minute submission grace).
  DELETE FROM app.form_sessions s
  WHERE s.expires_at + interval '7 days' < now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Lock down EXECUTE (still running as fn_owner, the functions' owner).
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.list_workspaces() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_personal_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_published_form(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_public_form(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.register_form_slug(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_form_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_expired_sessions() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.list_workspaces() TO app_user;
GRANT EXECUTE ON FUNCTION app.create_personal_workspace() TO app_user;
GRANT EXECUTE ON FUNCTION app.get_published_form(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.resolve_public_form(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.register_form_slug(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION app.resolve_form_session(text) TO app_user;
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO worker_user;

RESET ROLE;

-- fn_owner is NOLOGIN and never creates objects outside this migration:
-- take the transient schema-CREATE privilege back.
REVOKE CREATE ON SCHEMA app FROM fn_owner;
