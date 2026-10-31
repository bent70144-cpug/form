import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { uuidv7 } from "@form/database";
import { authTables } from "./auth-schema";

/**
 * The Better Auth instance mounted by apps/api under `/v1/auth/*`.
 *
 * Ticket 02 spike settings (recorded in docs/adr/0003-topology-spike.md):
 * - Drizzle adapter over the `auth` Postgres schema (`useSchema`-equivalent is
 *   achieved with drizzle `pgSchema("auth")` tables — better-auth 1.7.14 has
 *   no string `useSchema` option; schema qualification lives in the table
 *   definitions).
 * - UUID user IDs: `advanced.database.generateId: () => uuidv7()` (the exact
 *   setting supported by the pinned 1.7.14 — IDs stay stored in Better Auth's
 *   `text` columns but carry UUIDv7 values, satisfying ADR 0002's UUID
 *   consistency rule for `app.user_id` and policies).
 * - Secret and origin come from the environment: BETTER_AUTH_SECRET and
 *   APP_ORIGIN (both supervisor-allowlisted for the API child only).
 */
export interface CreateAuthOptions {
  databaseUrl: string;
  appOrigin: string;
  secret: string;
  /** Caller-owned pool (tests close it); default: internal pool from the URL. */
  pool?: Pool;
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    // Runtime schema qualification lives in the pgSchema("auth") tables; the
    // adapter's `schemaName` option drives the CLI schema generator only.
    database: drizzleAdapter(drizzle(options.pool ?? options.databaseUrl), {
      provider: "pg",
      schema: authTables,
    }),
    secret: options.secret,
    baseURL: options.appOrigin,
    basePath: "/v1/auth",
    trustedOrigins: [options.appOrigin],
    emailAndPassword: { enabled: true },
    advanced: {
      database: {
        generateId: () => uuidv7(),
      },
    },
    rateLimit: {
      // The NestJS limiter (trusted-proxy aware) arrives in ticket 04; keep
      // Better Auth's built-in limiter off so the spike hop is deterministic.
      enabled: false,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
