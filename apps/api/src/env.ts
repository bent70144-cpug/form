import { z } from "zod";

/**
 * Zod-validated API process environment (spec: "environment configuration is
 * Zod-validated and fails at startup"). The API child receives the pooled
 * app_user URL, the app origin, and the Better Auth secret — never the
 * migrator URL (supervisor allowlist).
 *
 * Ticket 03 adds the email-transport configuration: the dev mail sink
 * (SMTP_HOST/SMTP_PORT) or the deployed Resend HTTPS provider
 * (EMAIL_PROVIDER=resend + RESEND_API_KEY). EMAIL_PROVIDER is validated
 * against the exact provider set — a typo fails startup instead of silently
 * dropping verification email.
 */
const apiEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL (pooled app_user URL) is required"),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be set (min 16 chars)"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // --- verification email transport (ticket 03) ---
  EMAIL_PROVIDER: z.enum(["mail_sink", "resend"]).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  EMAIL_FROM: z.string().min(3).optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = apiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid API environment — refusing to start (${issues})`);
  }
  return parsed.data;
}
