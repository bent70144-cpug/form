/**
 * Drizzle schema module (spec: "A database package owns the Drizzle schema").
 *
 * The three schemas are created by the one-time admin bootstrap. Domain tables
 * (workspaces, projects, forms, drafts, versions, slugs, sessions,
 * submissions, outbox, audit) are added to this module by their own tickets:
 * 05 (workspaces), 06 (projects/forms/drafts), 09 (versions/slugs), 10
 * (sessions/submissions/outbox/audit). Ticket 01 intentionally creates NO
 * domain tables.
 */
export declare const appSchema: import("drizzle-orm/pg-core").PgSchema<"app">;
export declare const authSchema: import("drizzle-orm/pg-core").PgSchema<"auth">;
export declare const pgbossSchema: import("drizzle-orm/pg-core").PgSchema<"pgboss">;
/** Placeholder until domain tables land; keep imports type-safe meanwhile. */
export declare const appTables: {};
//# sourceMappingURL=index.d.ts.map