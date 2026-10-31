import {
  boolean,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Better Auth tables in the non-public `auth` Postgres schema.
 *
 * Column names match EXACTLY the DDL Better Auth 1.7.14 compiles for the
 * Kysely adapter (`getMigrations` → `compileMigrations()`, camelCase quoted
 * identifiers, timestamptz). The runtime mount uses Drizzle for DML; the DDL
 * itself is owned by migrations in production (spike: executed as the admin in
 * the test setup — see docs/adr/0003-topology-spike.md).
 */
export const authSchema = pgSchema("auth");

export const user = authSchema.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("user_email_unique").on(t.email)]);

export const session = authSchema.table("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("session_token_unique").on(t.token),
  index("session_userId_idx").on(t.userId),
]);

export const account = authSchema.table("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("account_userId_idx").on(t.userId)]);

export const verification = authSchema.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("verification_identifier_idx").on(t.identifier)]);

/** Model-name → drizzle table map handed to better-auth's drizzle adapter. */
export const authTables = { user, session, account, verification } as const;
