/**
 * Web process environment (spec: "The web app has no database URL or auth
 * secret" and "environment configuration is Zod-validated and fails at
 * startup").
 *
 * Dependency-free whitelist schema (zod lives in the API's env.ts; the web
 * deployable keeps its dependency surface minimal). The supervisor hands the
 * web child ONLY public variables:
 *
 *   API_INTERNAL_URL      — full internal API base (or…
 *   API_INTERNAL_PORT     — …a port on 127.0.0.1, default 4000)
 *   NEXT_PUBLIC_APP_ORIGIN— the public origin (informational; also derived
 *                           per-request in Next)
 *   PORT / NODE_ENV       — platform plumbing
 *
 * Anything secret (DATABASE_URL, BETTER_AUTH_SECRET, RESEND_API_KEY,
 * migrator URLs) must NEVER reach this process: the schema REFUSES to start
 * when one is present, so a supervisor allowlist regression fails loudly in
 * dev/CI instead of leaking a credential into the browser deployable.
 */

/** Keys the web process is allowed to consume (all non-secret/public). */
export const WEB_ENV_KEYS = [
  "PORT",
  "NODE_ENV",
  "API_INTERNAL_URL",
  "API_INTERNAL_PORT",
  "NEXT_PUBLIC_APP_ORIGIN",
] as const;

/** Keys whose presence in the web process is always a configuration bug. */
export const FORBIDDEN_WEB_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "MIGRATOR_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "RESEND_API_KEY",
] as const;

const NODE_ENVS = new Set(["development", "test", "production"]);

export class WebEnvError extends Error {
  constructor(issues: string[]) {
    super(
      `Invalid web environment — refusing to start (${issues.join("; ")})`,
    );
    this.name = "WebEnvError";
  }
}

export interface WebEnv {
  PORT: number;
  NODE_ENV: "development" | "test" | "production";
  API_INTERNAL_URL?: string;
  API_INTERNAL_PORT?: number;
  NEXT_PUBLIC_APP_ORIGIN?: string;
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * Validates the web process environment; throws WebEnvError on any problem.
 * Takes a plain record (not NodeJS.ProcessEnv) so Next's augmented `env`
 * typing cannot mask what the process actually received.
 */
export function loadWebEnv(
  env: Record<string, string | undefined> = process.env,
): WebEnv {
  const issues: string[] = [];

  for (const key of FORBIDDEN_WEB_ENV_KEYS) {
    if (isPresent(env[key])) {
      issues.push(`${key} must not be set in the web process (public deployable)`);
    }
  }

  let port = 3000;
  if (isPresent(env.PORT)) {
    const parsed = Number(env.PORT);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      issues.push(`PORT: expected an integer port, got "${env.PORT}"`);
    } else {
      port = parsed;
    }
  }

  let nodeEnv: WebEnv["NODE_ENV"] = "development";
  if (isPresent(env.NODE_ENV)) {
    if (!NODE_ENVS.has(env.NODE_ENV as string)) {
      issues.push(`NODE_ENV: unexpected value "${env.NODE_ENV}"`);
    } else {
      nodeEnv = env.NODE_ENV as WebEnv["NODE_ENV"];
    }
  }

  if (isPresent(env.API_INTERNAL_URL)) {
    const url = env.API_INTERNAL_URL as string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        issues.push(`API_INTERNAL_URL: expected an http(s) URL, got "${url}"`);
      }
    } catch {
      issues.push(`API_INTERNAL_URL: not a valid URL ("${url}")`);
    }
  }

  let apiInternalPort: number | undefined;
  if (isPresent(env.API_INTERNAL_PORT)) {
    const parsed = Number(env.API_INTERNAL_PORT);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      issues.push(
        `API_INTERNAL_PORT: expected an integer port, got "${env.API_INTERNAL_PORT}"`,
      );
    } else {
      apiInternalPort = parsed;
    }
  }

  if (issues.length > 0) throw new WebEnvError(issues);

  return {
    PORT: port,
    NODE_ENV: nodeEnv,
    ...(isPresent(env.API_INTERNAL_URL)
      ? { API_INTERNAL_URL: env.API_INTERNAL_URL as string }
      : {}),
    ...(apiInternalPort !== undefined ? { API_INTERNAL_PORT: apiInternalPort } : {}),
    ...(isPresent(env.NEXT_PUBLIC_APP_ORIGIN)
      ? { NEXT_PUBLIC_APP_ORIGIN: env.NEXT_PUBLIC_APP_ORIGIN as string }
      : {}),
  };
}
