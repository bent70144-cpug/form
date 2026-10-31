-- 0001_foundation.sql — bookkeeping table and the role grant pattern.
--
-- Ticket 01 scope: NO domain tables (those arrive with tickets 05/06/09/10),
-- no RLS policies yet, no security-definer functions yet, no pg-boss DDL yet.
--
-- NOTE (ticket 02): the `pgboss` schema DDL is installed by the migrator in a
-- later migration; pg-boss's own internal migration is skipped (the alpha
-- topology spike verifies the supported option). The schema itself already
-- exists, owned by `migrator`, created by the admin bootstrap.

CREATE TABLE IF NOT EXISTS app.migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Role grant pattern (spec: "Migrations run as the migrator table owner...
-- the runtime role gets DML only"; no runtime role has BYPASSRLS).
GRANT USAGE ON SCHEMA app TO app_user, worker_user, fn_owner;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO worker_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_user, worker_user;

-- The bookkeeping table itself was created before the default privileges
-- above, so it gets explicit grants (read-only for observability).
GRANT SELECT ON app.migrations TO app_user, worker_user;

-- Runtime roles must not create objects in the app schema (they get DML on
-- tables via default privileges; DDL stays with the migrator).
REVOKE CREATE ON SCHEMA app FROM app_user, worker_user, fn_owner;
