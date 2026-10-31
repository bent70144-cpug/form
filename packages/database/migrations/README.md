# Migrations

Plain SQL migrations run by the runner in `@form/database` (`pnpm db:migrate`).

Rules (spec: "Repository and runtime", "Tenancy and authorization"):

- Migrations run as the **`migrator`** role (`MIGRATOR_DATABASE_URL`), which owns
  the `app`, `auth`, and `pgboss` schemas. The one-time admin bootstrap
  (`pnpm db:bootstrap`) is a separate operation run with admin credentials —
  it must never be part of migrations.
- Each file is `NNNN_description.sql`, applied exactly once, tracked in
  `app.migrations` (name + sha256 checksum). A checksum mismatch fails loudly
  instead of silently running drift.
- Every migration runs in its own transaction.
- Role passwords never appear in migration files — they come from environment
  variables consumed by the bootstrap script.
- Tenant tables must carry forced RLS with both `USING` and `WITH CHECK`
  clauses, composite `(workspace_id, id)` keys, and DML-only grants for
  `app_user` / `worker_user` (enforced by later tickets' catalog guard).
- The `pgboss` schema DDL will be installed by the migrator in a later
  migration (ticket 02); pg-boss's own migration step is skipped — the alpha
  topology spike confirms the supported option.
