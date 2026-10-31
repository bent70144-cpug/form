-- 0004_forms.sql — form builder domain (ticket 06).
--
-- forms, form_drafts (one mutable row per form), form_versions (immutable
-- published snapshots), form_slugs (global slug registry with redirect flag).
-- All four are tenant tables: forced RLS, both-clause policies, root link
-- workspace_id -> workspaces(id), and composite FKs referencing the parent's
-- UNIQUE (workspace_id, id) so a form can never point at another workspace's
-- project, draft, or published version.

DO $$
BEGIN
  CREATE TYPE app.form_status AS ENUM ('draft', 'published', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS app.forms (
  id                   uuid PRIMARY KEY,     -- app-side UUIDv7 (ADR 0002)
  workspace_id         uuid NOT NULL REFERENCES app.workspaces(id),
  project_id           uuid NOT NULL,
  name                 text NOT NULL,
  status               app.form_status NOT NULL DEFAULT 'draft',
  current_draft_id     uuid,                 -- FK added after form_drafts
  published_version_id uuid,                 -- FK added after form_versions
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT forms_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.form_drafts (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES app.workspaces(id),
  form_id        uuid NOT NULL,
  schema         jsonb NOT NULL,             -- full form schema envelope
  draft_version  integer NOT NULL DEFAULT 0, -- bumped on every save
  last_edited_by uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT form_drafts_ws_form_uq UNIQUE (workspace_id, form_id),
  CONSTRAINT form_drafts_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.form_versions (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES app.workspaces(id),
  form_id        uuid NOT NULL,
  version_number integer NOT NULL,
  schema         jsonb NOT NULL,             -- immutable snapshot
  published_by   uuid,
  published_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_versions_form_version_uq UNIQUE (form_id, version_number),
  CONSTRAINT form_versions_ws_id_uq UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app.form_slugs (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  form_id      uuid NOT NULL,
  slug         text NOT NULL,                -- globally unique registry key
  is_current   boolean NOT NULL DEFAULT true, -- false = kept as redirect
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT form_slugs_slug_uq UNIQUE (slug),
  CONSTRAINT form_slugs_ws_id_uq UNIQUE (workspace_id, id)
);

-- M0 slugs are 10-char base62; enforced again (with the reserved-word list)
-- inside register_form_slug().
ALTER TABLE app.form_slugs
  ADD CONSTRAINT form_slugs_slug_format_ck CHECK (slug ~ '^[A-Za-z0-9]{10}$');

-- One current slug per form; superseded rows (is_current = false) become
-- redirects resolved by get_published_form().
CREATE UNIQUE INDEX IF NOT EXISTS form_slugs_current_uq
  ON app.form_slugs (workspace_id, form_id) WHERE is_current;

CREATE INDEX IF NOT EXISTS form_slugs_ws_form_idx
  ON app.form_slugs (workspace_id, form_id);

CREATE INDEX IF NOT EXISTS forms_ws_project_idx
  ON app.forms (workspace_id, project_id);

-- Composite tenant FKs (workspace_id + parent id) -> parent UNIQUE pair.
ALTER TABLE app.forms
  ADD CONSTRAINT forms_project_composite_fk
  FOREIGN KEY (workspace_id, project_id) REFERENCES app.projects (workspace_id, id);

ALTER TABLE app.form_drafts
  ADD CONSTRAINT form_drafts_form_composite_fk
  FOREIGN KEY (workspace_id, form_id) REFERENCES app.forms (workspace_id, id);

ALTER TABLE app.form_versions
  ADD CONSTRAINT form_versions_form_composite_fk
  FOREIGN KEY (workspace_id, form_id) REFERENCES app.forms (workspace_id, id);

ALTER TABLE app.form_slugs
  ADD CONSTRAINT form_slugs_form_composite_fk
  FOREIGN KEY (workspace_id, form_id) REFERENCES app.forms (workspace_id, id);

-- Circular pointers back from forms (nullable, so the cycle is addable):
-- the current draft and the pinned published version are composite FKs too.
ALTER TABLE app.forms
  ADD CONSTRAINT forms_current_draft_composite_fk
  FOREIGN KEY (workspace_id, current_draft_id) REFERENCES app.form_drafts (workspace_id, id);

ALTER TABLE app.forms
  ADD CONSTRAINT forms_published_version_composite_fk
  FOREIGN KEY (workspace_id, published_version_id) REFERENCES app.form_versions (workspace_id, id);

-- ---------------------------------------------------------------------------
-- Forced RLS + both-clause policies (same pattern as 0002).
-- ---------------------------------------------------------------------------

ALTER TABLE app.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.forms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forms_tenant_rls ON app.forms;
CREATE POLICY forms_tenant_rls ON app.forms
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.form_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_drafts_tenant_rls ON app.form_drafts;
CREATE POLICY form_drafts_tenant_rls ON app.form_drafts
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_versions_tenant_rls ON app.form_versions;
CREATE POLICY form_versions_tenant_rls ON app.form_versions
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE app.form_slugs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_slugs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_slugs_tenant_rls ON app.form_slugs;
CREATE POLICY form_slugs_tenant_rls ON app.form_slugs
  TO app_user, worker_user
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
