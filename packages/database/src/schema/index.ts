import { pgSchema } from "drizzle-orm/pg-core";

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
export const appSchema = pgSchema("app");
export const authSchema = pgSchema("auth");
export const pgbossSchema = pgSchema("pgboss");

/** Placeholder until domain tables land; keep imports type-safe meanwhile. */
export const appTables = {} as const;
