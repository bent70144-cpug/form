"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapDatabase = bootstrapDatabase;
const pg_1 = require("pg");
const ROLES = [
    { name: "migrator", login: true },
    { name: "app_user", login: true },
    { name: "worker_user", login: true },
    { name: "fn_owner", login: false },
];
const SCHEMAS = ["app", "auth", "pgboss"];
/** Identifiers are fixed constants, but quote defensively anyway. */
function ident(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
function literal(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
async function bootstrapDatabase(options) {
    const admin = new pg_1.Client({ connectionString: options.adminUrl });
    await admin.connect();
    const summary = {
        createdRoles: [],
        alignedRoles: [],
        schemas: [],
        fnOwnerMembershipGranted: false,
        database: "",
    };
    try {
        const databaseRow = await admin.query("SELECT current_database() AS db");
        summary.database = databaseRow.rows[0]?.db ?? "";
        const passwords = {
            migrator: options.migratorPassword,
            app_user: options.appUserPassword,
            worker_user: options.workerPassword,
            fn_owner: undefined,
        };
        const existing = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [ROLES.map((r) => r.name)]);
        const existingNames = new Set(existing.rows.map((r) => r.rolname));
        for (const role of ROLES) {
            const roleOptions = "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS" +
                (role.login ? " LOGIN" : " NOLOGIN");
            const passwordClause = role.login
                ? ` PASSWORD ${literal(passwords[role.name] ?? "")}`
                : "";
            if (!existingNames.has(role.name)) {
                await admin.query(`CREATE ROLE ${ident(role.name)} WITH ${roleOptions}${passwordClause}`);
                summary.createdRoles.push(role.name);
            }
            else {
                await admin.query(`ALTER ROLE ${ident(role.name)} WITH ${roleOptions}${passwordClause}`);
                summary.alignedRoles.push(role.name);
            }
        }
        for (const schema of SCHEMAS) {
            await admin.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)} AUTHORIZATION ${ident("migrator")}`);
            // Keep ownership aligned even if the schema pre-existed with another owner.
            await admin.query(`ALTER SCHEMA ${ident(schema)} OWNER TO ${ident("migrator")}`);
            summary.schemas.push(schema);
        }
        const dbIdent = ident(summary.database);
        await admin.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${ident("migrator")}, ${ident("app_user")}, ${ident("worker_user")}`);
        const membership = await admin.query(`SELECT EXISTS (
         SELECT 1 FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
         WHERE g.rolname = 'fn_owner' AND u.rolname = 'migrator'
       ) AS granted`);
        if (!membership.rows[0]?.granted) {
            // WITH ADMIN OPTION: migrator may SET ROLE fn_owner and grant it onward
            // — this is how migrations assign function ownership without superuser.
            await admin.query(`GRANT ${ident("fn_owner")} TO ${ident("migrator")} WITH ADMIN OPTION`);
            summary.fnOwnerMembershipGranted = true;
        }
        return summary;
    }
    finally {
        await admin.end();
    }
}
//# sourceMappingURL=bootstrap.js.map