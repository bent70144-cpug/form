import { Client } from "pg";

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

interface RoleSpec {
  name: string;
  login: boolean;
  password?: string;
}

const ROLES: RoleSpec[] = [
  { name: "migrator", login: true },
  { name: "app_user", login: true },
  { name: "worker_user", login: true },
  { name: "fn_owner", login: false },
];

const SCHEMAS = ["app", "auth", "pgboss"] as const;

/** Identifiers are fixed constants, but quote defensively anyway. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function bootstrapDatabase(
  options: BootstrapOptions,
): Promise<BootstrapSummary> {
  const admin = new Client({ connectionString: options.adminUrl });
  await admin.connect();
  const summary: BootstrapSummary = {
    createdRoles: [],
    alignedRoles: [],
    schemas: [],
    fnOwnerMembershipGranted: false,
    database: "",
  };

  try {
    const databaseRow = await admin.query<{ db: string }>(
      "SELECT current_database() AS db",
    );
    summary.database = databaseRow.rows[0]?.db ?? "";

    const passwords: Record<string, string | undefined> = {
      migrator: options.migratorPassword,
      app_user: options.appUserPassword,
      worker_user: options.workerPassword,
      fn_owner: undefined,
    };

    const existing = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
      [ROLES.map((r) => r.name)],
    );
    const existingNames = new Set(existing.rows.map((r) => r.rolname));

    for (const role of ROLES) {
      const roleOptions =
        "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS" +
        (role.login ? " LOGIN" : " NOLOGIN");
      const passwordClause = role.login
        ? ` PASSWORD ${literal(passwords[role.name] ?? "")}`
        : "";
      if (!existingNames.has(role.name)) {
        await admin.query(
          `CREATE ROLE ${ident(role.name)} WITH ${roleOptions}${passwordClause}`,
        );
        summary.createdRoles.push(role.name);
      } else {
        await admin.query(
          `ALTER ROLE ${ident(role.name)} WITH ${roleOptions}${passwordClause}`,
        );
        summary.alignedRoles.push(role.name);
      }
    }

    for (const schema of SCHEMAS) {
      await admin.query(
        `CREATE SCHEMA IF NOT EXISTS ${ident(schema)} AUTHORIZATION ${ident("migrator")}`,
      );
      // Keep ownership aligned even if the schema pre-existed with another owner.
      await admin.query(
        `ALTER SCHEMA ${ident(schema)} OWNER TO ${ident("migrator")}`,
      );
      summary.schemas.push(schema);
    }

    const dbIdent = ident(summary.database);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${dbIdent} TO ${ident("migrator")}, ${ident("app_user")}, ${ident("worker_user")}`,
    );

    const membership = await admin.query<{ granted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
         WHERE g.rolname = 'fn_owner' AND u.rolname = 'migrator'
       ) AS granted`,
    );
    if (!membership.rows[0]?.granted) {
      // WITH ADMIN OPTION: migrator may SET ROLE fn_owner and grant it onward
      // — this is how migrations assign function ownership without superuser.
      await admin.query(
        `GRANT ${ident("fn_owner")} TO ${ident("migrator")} WITH ADMIN OPTION`,
      );
      summary.fnOwnerMembershipGranted = true;
    }

    return summary;
  } finally {
    await admin.end();
  }
}
