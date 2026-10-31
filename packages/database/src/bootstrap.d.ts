/**
 * One-time admin bootstrap (spec: "A one-time admin bootstrap, run with admin
 * credentials and not as a migration, creates the `app`, `auth`, and `pgboss`
 * schemas and the `migrator`, `app_user`, `worker_user`, and NOLOGIN
 * `fn_owner` roles").
 *
 * Guarantees:
 * - Roles are created with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`;
 *   `fn_owner` is NOLOGIN. Nothing here grants BYPASSRLS.
 * - Role passwords come from environment variables (via the caller) and never
 *   appear in migration files.
 * - `GRANT fn_owner TO migrator WITH ADMIN OPTION` lets migrations `SET ROLE
 *   fn_owner` and assign function ownership (`ALTER FUNCTION ... OWNER TO
 *   fn_owner`) without superuser.
 * - Idempotent: safe to re-run; missing objects are created, existing ones are
 *   aligned (passwords refreshed, schema ownership corrected).
 */
export interface BootstrapOptions {
    /** Superuser (admin) connection string targeting the application database. */
    adminUrl: string;
    migratorPassword: string;
    appUserPassword: string;
    workerPassword: string;
}
export interface BootstrapSummary {
    createdRoles: string[];
    alignedRoles: string[];
    schemas: string[];
    fnOwnerMembershipGranted: boolean;
    database: string;
}
export declare function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapSummary>;
//# sourceMappingURL=bootstrap.d.ts.map