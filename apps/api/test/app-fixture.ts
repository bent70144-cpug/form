import { Kysely, PostgresDialect } from "kysely";
import { Client, Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import type { EmailProvider } from "@form/auth/server";
import {
  createScratchDatabase,
  dropDatabase,
  ensureBootstrapped,
  type BootstrappedUrls,
} from "@form/database/testing";
import { createMailSink } from "../../../scripts/mail-sink.mjs";
import { createApiApp } from "../src/app";
import { loadApiEnv, type ApiEnv } from "../src/env";
import { AUTH_SCHEMA } from "./helpers";

/** The dev sink instance type (inferred — see scripts/mail-sink.mjs). */
type MailSinkInstance = ReturnType<typeof createMailSink>;

/**
 * Shared fixture for the auth-core suites: scratch database + Better Auth
 * DDL (admin step, as in the ticket-02 spike) + app_user DML grants + the
 * runtime app wired to an EPHEMERAL mail-sink instance (the decided Mailpit
 * substitute) so verification emails can be asserted without touching the
 * dev supervisor's sink on fixed ports.
 */
export interface AuthCoreFixture {
  appName: string;
  appOrigin: string;
  urls: BootstrappedUrls;
  adminClient: Client;
  authPool: Pool;
  sink: MailSinkInstance;
  env: ApiEnv;
  expressApp: Awaited<ReturnType<typeof createApiApp>>["expressApp"];
  auth: Awaited<ReturnType<typeof createApiApp>>["auth"];
  /** The app's process-wide limiter (rate-limit suites drive it via HTTP). */
  rateLimiter: Awaited<ReturnType<typeof createApiApp>>["rateLimiter"];
  /** The guarded pooled app_user tenant connection (ticket 05 workspaces). */
  dbPool: Awaited<ReturnType<typeof createApiApp>>["dbPool"];
  /** Reads the sink mailbox over its HTTP API (GET /dev/mailbox). */
  mailbox(): Promise<{ messages: Array<{ id: number; to: string[]; raw: string }> }>;
  /** Clears the sink mailbox (DELETE /dev/mailbox). */
  clearMailbox(): Promise<void>;
  close(): Promise<void>;
}

export async function createAuthCoreFixture(
  scratchDb: string,
  overrides: Partial<Record<string, string>> = {},
  /** Extra createApiApp options (email provider / rate-limit switch). */
  appOptions: {
    emailProvider?: EmailProvider;
    rateLimits?: { enabled?: boolean };
  } = {},
): Promise<AuthCoreFixture> {
  const appName = "http://localhost:3000";
  await createScratchDatabase(scratchDb);
  const urls = await ensureBootstrapped(scratchDb);
  const adminClient = new Client({ connectionString: urls.adminUrl });
  await adminClient.connect();

  // Better Auth's own compiled DDL for the `auth` schema, run as the ADMIN
  // (test-time equivalent of the production migrator step — ADR 0003).
  const ddlPool = new Pool({ connectionString: urls.adminUrl, max: 1 });
  const kysely = new Kysely({ dialect: new PostgresDialect({ pool: ddlPool }) });
  const { runMigrations } = await getMigrations(
    {
      database: { db: kysely, type: "postgres", schemaName: AUTH_SCHEMA },
      plugins: [],
      rateLimit: { enabled: false },
    } as never,
    { throwOnUnsafe: false },
  );
  await runMigrations();
  await kysely.destroy();

  // Runtime DML grants for app_user (no CREATE — asserted elsewhere).
  for (const sql of [
    `GRANT USAGE ON SCHEMA ${AUTH_SCHEMA} TO app_user`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${AUTH_SCHEMA} TO app_user`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${AUTH_SCHEMA} TO app_user`,
  ]) {
    await adminClient.query(sql);
  }

  // Dev mail sink on ephemeral ports (0 = OS-assigned).
  const sink = createMailSink({ smtpPort: 0, httpPort: 0 });
  const { smtpPort, httpPort } = await sink.start();

  const authPool = new Pool({ connectionString: urls.appUserUrl, max: 5 });
  const env = loadApiEnv({
    PORT: "4000",
    DATABASE_URL: urls.appUserUrl,
    APP_ORIGIN: appName,
    BETTER_AUTH_SECRET: "auth-core-test-secret-0123456789",
    NODE_ENV: "test",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort ?? 0),
    ...overrides,
  });
  const app = await createApiApp(env, {
    authPool,
    ...appOptions,
    // Ticket-04 rate limits are OFF for the shared fixture: the auth-core /
    // round-trip suites perform many loopback sign-ins and would trip the
    // per-IP sign-in limit for reasons unrelated to what they assert. The
    // dedicated suites (auth-rate-limit, auth-reset, trusted-ip-rewrite) pass
    // `rateLimits: { enabled: true }` and drive the REAL limits end-to-end.
    rateLimits: appOptions.rateLimits ?? { enabled: false },
  });

  const mailboxBase = `http://127.0.0.1:${httpPort ?? 0}/dev/mailbox`;
  return {
    appName,
    appOrigin: appName,
    urls,
    adminClient,
    authPool,
    sink,
    env,
    expressApp: app.expressApp,
    auth: app.auth,
    rateLimiter: app.rateLimiter,
    dbPool: app.dbPool,
    async mailbox() {
      const res = await fetch(mailboxBase);
      if (!res.ok) throw new Error(`mailbox read failed: ${res.status}`);
      return (await res.json()) as { messages: Array<{ id: number; to: string[]; raw: string }> };
    },
    async clearMailbox() {
      await fetch(mailboxBase, { method: "DELETE" });
    },
    async close() {
      await sink.stop().catch(() => undefined);
      await authPool.end().catch(() => undefined);
      await app.dbPool.end().catch(() => undefined);
      await adminClient.end();
      await dropDatabase(scratchDb);
    },
  };
}

/** Extracts the first verification URL found in a raw mail body. */
export function extractVerificationUrl(rawMail: string): string {
  const match = rawMail.match(/https?:\/\/\S+\/v1\/auth\/verify-email\?token=\S+/);
  if (!match) throw new Error(`no verification URL in mail body: ${rawMail.slice(0, 400)}`);
  return match[0].replace(/["\s]+$/, "");
}

/** Joins Set-Cookie headers into a request Cookie header (name=value pairs). */
export function cookieHeaderOf(setCookies: unknown): string {
  return (setCookies as string[]).map((c) => c.split(";")[0]).join("; ");
}
