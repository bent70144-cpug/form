import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema module (spec: "A database package owns the Drizzle schema").
 *
 * The three schemas are created by the one-time admin bootstrap. The domain
 * tables below mirror migrations 0002–0005 exactly (tickets 05/06/09/10):
 * every tenant table has an app-side UUID PK, `workspace_id NOT NULL`
 * (root link to workspaces), timestamps + soft delete, and a
 * UNIQUE (workspace_id, id) pair referenced by composite foreign keys.
 * `outbox_events` is intentionally NOT a tenant table — no RLS, the workspace
 * id travels in the payload, and app_user inserts WITHOUT `.returning()`
 * (no SELECT grant).
 */
export const appSchema = pgSchema("app");
export const authSchema = pgSchema("auth");
export const pgbossSchema = pgSchema("pgboss");

export const workspaceRole = appSchema.enum("workspace_role", [
  "owner",
  "admin",
  "editor",
  "viewer",
]);

export const formStatus = appSchema.enum("form_status", [
  "draft",
  "published",
  "closed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

export const workspaces = appSchema.table(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    creator: uuid("creator").notNull(),
    isPersonal: boolean("is_personal").notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("workspaces_personal_creator_uq").on(t.creator)],
);

export const workspaceMembers = appSchema.table(
  "workspace_members",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id").notNull(),
    role: workspaceRole("role").notNull().default("viewer"),
    ...timestamps,
  },
  (t) => [
    unique("workspace_members_ws_user_uq").on(t.workspaceId, t.userId),
    unique("workspace_members_ws_id_uq").on(t.workspaceId, t.id),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const workspaceInvitations = appSchema.table(
  "workspace_invitations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    role: workspaceRole("role").notNull().default("viewer"),
    hashedToken: text("hashed_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedBy: uuid("invited_by").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [unique("workspace_invitations_ws_id_uq").on(t.workspaceId, t.id)],
);

export const projects = appSchema.table(
  "projects",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("projects_ws_id_uq").on(t.workspaceId, t.id)],
);

export const auditLogs = appSchema.table(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actor: uuid("actor"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("audit_logs_ws_id_uq").on(t.workspaceId, t.id),
    index("audit_logs_ws_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const outboxEvents = appSchema.table(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deadLettereAt: timestamp("dead_lettered_at", { withTimezone: true }),
  },
  (t) => [index("outbox_events_dispatch_idx").on(t.availableAt)],
);

export const forms = appSchema.table(
  "forms",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    status: formStatus("status").notNull().default("draft"),
    currentDraftId: uuid("current_draft_id"),
    publishedVersionId: uuid("published_version_id"),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("forms_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "forms_project_composite_fk",
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    // Circular pointers back from forms (nullable columns; evaluated lazily
    // by drizzle, after the module finishes initialising).
    foreignKey({
      name: "forms_current_draft_composite_fk",
      columns: [t.workspaceId, t.currentDraftId],
      foreignColumns: [formDrafts.workspaceId, formDrafts.id],
    }),
    foreignKey({
      name: "forms_published_version_composite_fk",
      columns: [t.workspaceId, t.publishedVersionId],
      foreignColumns: [formVersions.workspaceId, formVersions.id],
    }),
    index("forms_ws_project_idx").on(t.workspaceId, t.projectId),
  ],
);

export const formDrafts = appSchema.table(
  "form_drafts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    formId: uuid("form_id").notNull(),
    schema: jsonb("schema").notNull(),
    draftVersion: integer("draft_version").notNull().default(0),
    lastEditedBy: uuid("last_edited_by"),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("form_drafts_ws_form_uq").on(t.workspaceId, t.formId),
    unique("form_drafts_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "form_drafts_form_composite_fk",
      columns: [t.workspaceId, t.formId],
      foreignColumns: [forms.workspaceId, forms.id],
    }),
  ],
);

export const formVersions = appSchema.table(
  "form_versions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    formId: uuid("form_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    schema: jsonb("schema").notNull(),
    publishedBy: uuid("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("form_versions_form_version_uq").on(t.formId, t.versionNumber),
    unique("form_versions_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "form_versions_form_composite_fk",
      columns: [t.workspaceId, t.formId],
      foreignColumns: [forms.workspaceId, forms.id],
    }),
  ],
);

export const formSlugs = appSchema.table(
  "form_slugs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    formId: uuid("form_id").notNull(),
    slug: text("slug").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("form_slugs_slug_uq").on(t.slug),
    unique("form_slugs_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "form_slugs_form_composite_fk",
      columns: [t.workspaceId, t.formId],
      foreignColumns: [forms.workspaceId, forms.id],
    }),
    index("form_slugs_ws_form_idx").on(t.workspaceId, t.formId),
  ],
);

export const formSessions = appSchema.table(
  "form_sessions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    formId: uuid("form_id").notNull(),
    formVersionId: uuid("form_version_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("form_sessions_token_hash_uq").on(t.tokenHash),
    unique("form_sessions_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "form_sessions_form_composite_fk",
      columns: [t.workspaceId, t.formId],
      foreignColumns: [forms.workspaceId, forms.id],
    }),
    foreignKey({
      name: "form_sessions_version_composite_fk",
      columns: [t.workspaceId, t.formVersionId],
      foreignColumns: [formVersions.workspaceId, formVersions.id],
    }),
    index("form_sessions_ws_form_idx").on(t.workspaceId, t.formId),
  ],
);

export const submissions = appSchema.table(
  "submissions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    formId: uuid("form_id").notNull(),
    formVersionId: uuid("form_version_id").notNull(),
    formSessionId: uuid("form_session_id").notNull(),
    answers: jsonb("answers").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("submissions_session_uq").on(t.formSessionId),
    unique("submissions_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "submissions_form_composite_fk",
      columns: [t.workspaceId, t.formId],
      foreignColumns: [forms.workspaceId, forms.id],
    }),
    foreignKey({
      name: "submissions_version_composite_fk",
      columns: [t.workspaceId, t.formVersionId],
      foreignColumns: [formVersions.workspaceId, formVersions.id],
    }),
    foreignKey({
      name: "submissions_session_composite_fk",
      columns: [t.workspaceId, t.formSessionId],
      foreignColumns: [formSessions.workspaceId, formSessions.id],
    }),
    index("submissions_ws_form_created_idx").on(
      t.workspaceId,
      t.formId,
      t.createdAt,
    ),
  ],
);

/** All app-schema domain tables, for typed Drizzle usage elsewhere. */
export const appTables = {
  workspaces,
  workspaceMembers,
  workspaceInvitations,
  projects,
  auditLogs,
  outboxEvents,
  forms,
  formDrafts,
  formVersions,
  formSlugs,
  formSessions,
  submissions,
} as const;
