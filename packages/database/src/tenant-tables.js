"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENANT_TABLES = void 0;
exports.isTenantQuery = isTenantQuery;
/**
 * Tenant tables (spec: "Data model"). These are the tables that carry
 * `workspace_id NOT NULL` with forced RLS once their tickets create them
 * (tickets 05, 06, 09, 10). Ticket 01 establishes the query guard over this
 * list BEFORE any of the tables exist, so tenant access patterns are already
 * enforced by construction.
 *
 * `outbox_events` is intentionally NOT tenant (no RLS; the worker reads it
 * with worker_user). `audit_logs` IS tenant (forced RLS, append-only).
 */
exports.TENANT_TABLES = [
    "workspaces",
    "workspace_members",
    "workspace_invitations",
    "projects",
    "forms",
    "form_drafts",
    "form_versions",
    "form_slugs",
    "form_sessions",
    "submissions",
    "audit_logs",
];
const TENANT_TABLE_RE = new RegExp(`\\b(?:${exports.TENANT_TABLES.join("|")})\\b`, "i");
/** True when a SQL statement references a tenant table by name. */
function isTenantQuery(sql) {
    return TENANT_TABLE_RE.test(sql);
}
//# sourceMappingURL=tenant-tables.js.map