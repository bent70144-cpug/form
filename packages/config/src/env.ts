import { z } from "zod";

/**
 * Zod-validated environment configuration.
 *
 * The spec requires: "environment configuration is Zod-validated and fails at
 * startup" — every entrypoint parses its slice of process.env through one of
 * these schemas before doing any work. A missing or invalid value throws
 * `EnvValidationError` with a human-readable summary of ALL problems, so a
 * misconfigured deploy fails fast instead of limping along.
 */

export class EnvValidationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
    "must be a postgres:// URL",
  );

const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
const nodeEnv = z.enum(["development", "test", "production"]).default("development");

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Parse an environment object against a schema. Throws `EnvValidationError`
 * listing every problem when the input does not match — callers (app
 * entrypoints) must let this error abort startup.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      `Invalid environment configuration — refusing to start:\n${formatIssues(result.error.issues)}`,
      result.error.issues,
    );
  }
  return result.data;
}

/** API process (NestJS). Pooled app_user URL — never the migrator URL. */
export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  PORT: z.coerce.number().int().positive().default(4000),
  /** Pooled connection string used by request handling (role: app_user). */
  DATABASE_URL: postgresUrl,
  /** Public origin of the web app (used for the Origin check). */
  APP_ORIGIN: z.string().url(),
  LOG_LEVEL: logLevel.default("info"),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Worker process. Separate non-pooled role: worker_user. */
export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  WORKER_DATABASE_URL: postgresUrl,
  LOG_LEVEL: logLevel.default("info"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Web process. PUBLIC configuration only — no database URLs, no auth secrets
 * (the supervisor allowlist enforces this at spawn time and the web build
 * checks the import boundary; this schema is the third guardrail so a
 * misconfigured web process fails fast instead of silently leaking).
 */
export const webEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public origin browsers use (used for links and cookie scoping later). */
  APP_ORIGIN: z.string().url(),
  /** Internal (non-public) API base URL the server-side calls go to. */
  API_INTERNAL_URL: z.string().url(),
  API_INTERNAL_PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: logLevel.default("info"),
  NEXT_TELEMETRY_DISABLED: z.string().optional(),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

/** Migration runner. Direct (non-pooled) connection as the migrator role. */
export const migratorEnvSchema = z.object({
  MIGRATOR_DATABASE_URL: postgresUrl,
});
export type MigratorEnv = z.infer<typeof migratorEnvSchema>;

/**
 * One-time admin bootstrap (spec: run with admin credentials, never part of
 * request handling and never a migration). Role passwords come from
 * environment variables and NEVER appear in migration files.
 */
export const bootstrapEnvSchema = z.object({
  ADMIN_DATABASE_URL: postgresUrl,
  MIGRATOR_PASSWORD: z.string().min(8),
  APP_USER_PASSWORD: z.string().min(8),
  WORKER_PASSWORD: z.string().min(8),
});
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>;
