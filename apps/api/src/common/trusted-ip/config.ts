import { z } from "zod";

/**
 * Configuration for trusted-proxy client-IP derivation.
 *
 * `trustedProxyCount` is the number of reverse-proxy hops the API sits behind
 * (the direct socket peer is trusted hop #1). `trustedProxyHeaders` is the
 * priority-ordered list of request headers carrying the forwarded client
 * chain; the first header present with a parseable entry wins, later headers
 * are ignored (a platform that attests the client must not be second-guessed
 * by a header it does not own).
 */
export interface TrustedIpConfig {
  trustedProxyCount: number;
  trustedProxyHeaders: string[];
}

/**
 * Default forwarded-header chain, right-to-left. Render (alpha) attests the
 * client via `X-Forwarded-For`; when Cloudflare is added it is prepended here
 * (`cf-connecting-ip` first) and `TRUSTED_PROXY_COUNT` is raised to match.
 */
export const DEFAULT_TRUSTED_PROXY_HEADERS: readonly string[] = ["x-forwarded-for"];

/**
 * Zod-validated environment slice for the trusted-IP module (spec:
 * "environment configuration is Zod-validated and fails at startup").
 *
 * NOTE (ownership): `apps/api/src/env.ts` is owned by ticket 03's worktree, so
 * this schema lives inside the module for now. Ticket 04's endpoint wiring
 * merges these two variables into the main API env schema (see
 * docs/adr/0004-rate-limiting.md, "Wiring contract").
 */
const trustedIpEnvSchema = z.object({
  TRUSTED_PROXY_COUNT: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.coerce.number().int().min(0).max(64).optional(),
  ),
  /** Comma-separated header names, priority order (left = highest). */
  TRUSTED_PROXY_HEADERS: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().min(1).optional(),
  ),
});

/** Thrown when the trusted-IP environment slice fails Zod validation. */
export class TrustedIpConfigError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = "TrustedIpConfigError";
    this.issues = issues;
  }
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Loads the trusted-IP configuration from an environment record, applying
 * the deployment defaults: `TRUSTED_PROXY_COUNT` wins if set; otherwise 1
 * proxy hop on Render (the platform edge is the peer in front of the Next.js
 * rewrite) and 0 elsewhere (local dev — the peer is the Next process on
 * loopback and every forwarded header is ignored).
 *
 * Invalid values throw `TrustedIpConfigError` so a misconfigured deploy fails
 * at startup, mirroring the `@form/config` loadEnv contract.
 */
export function loadTrustedIpConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrustedIpConfig {
  const parsed = trustedIpEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new TrustedIpConfigError(
      `Invalid trusted-IP environment configuration — refusing to start:\n${formatIssues(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const { TRUSTED_PROXY_COUNT, TRUSTED_PROXY_HEADERS } = parsed.data;
  return {
    trustedProxyCount: TRUSTED_PROXY_COUNT ?? resolveDefaultTrustedProxyCount(env),
    trustedProxyHeaders: TRUSTED_PROXY_HEADERS
      ? splitHeaderList(TRUSTED_PROXY_HEADERS)
      : [...DEFAULT_TRUSTED_PROXY_HEADERS],
  };
}

/** Default proxy-hop count for the current deployment environment. */
export function resolveDefaultTrustedProxyCount(env: NodeJS.ProcessEnv): number {
  return isRenderEnv(env) ? 1 : 0;
}

/**
 * Render injects `RENDER=true` and `RENDER_SERVICE_ID` into every service
 * container; either marker means the platform proxy fronts the app.
 */
export function isRenderEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.RENDER === "true" ||
    env.RENDER === "1" ||
    (typeof env.RENDER_SERVICE_ID === "string" && env.RENDER_SERVICE_ID.length > 0)
  );
}

/** Parses `TRUSTED_PROXY_HEADERS` ("A, B") into lowercased header names. */
function splitHeaderList(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}
