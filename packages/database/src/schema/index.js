"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appTables = exports.pgbossSchema = exports.authSchema = exports.appSchema = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
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
exports.appSchema = (0, pg_core_1.pgSchema)("app");
exports.authSchema = (0, pg_core_1.pgSchema)("auth");
exports.pgbossSchema = (0, pg_core_1.pgSchema)("pgboss");
/** Placeholder until domain tables land; keep imports type-safe meanwhile. */
exports.appTables = {};
//# sourceMappingURL=index.js.map