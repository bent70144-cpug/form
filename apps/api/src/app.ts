import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Express } from "express";
import express from "express";
import type { Pool } from "pg";
import { createPool } from "@form/database";
import { createAuth, resolveEmailProvider } from "@form/auth/server";
import { AppModule } from "./app.module";
import { hopDiagnostics } from "./health.controller";
import { createRateLimitGuard, RateLimiter } from "./common/rate-limit";
import { trustedIpConfigFromValues, type TrustedIpConfig } from "./common/trusted-ip";
import { mountBetterAuth } from "./auth/mount";
import { originGuard } from "./common/origin-guard";
import { loadApiEnv } from "./env";

/**
 * Builds the API app without listening (shared by `main.ts` and the
 * integration tests). Order matters — the Origin guard must run BEFORE both
 * the mounted Better Auth handler and the Nest controllers (spec: "a global
 * Nest guard enforces that all state-changing calls originate in the
 * browser through the same-origin /v1/* rewrite"), and the ticket-04
 * rate-limit guard must run BEFORE the handlers it shields:
 *
 *   1. originGuard        — 403 `origin_mismatch` for state-changing requests
 *   2. express.json       — first-pass JSON body parse (the rate-limit guard
 *                           keys sign-in / reset requests per email; Better
 *                           Auth's node adapter reuses a parsed `req.body`)
 *   3. hopDiagnostics     — non-production response headers recording the
 *                           hop (replaces the ADR-0003 spike recorder)
 *   4. rateLimitGuard     — 429 `rate_limited` per the spec's auth limits
 *                           (trusted-proxy client IP; ADR-0004)
 *   5. Better Auth mount  — /v1/auth/* (prefix preserved, see mount.ts;
 *                           /v1/auth/session falls through to Nest)
 *   6. Nest router        — /v1/health, /v1/auth/session, /v1/probe/*, future
 *                           /v1 endpoints
 */
export async function createApiApp(
  env = loadApiEnv(),
  options: {
    authPool?: Pool;
    emailProvider?: ReturnType<typeof resolveEmailProvider>;
    /**
     * Rate-limit switch. ON by default (production-correct); the shared test
     * fixture turns it OFF so suites that sign in many times from loopback
     * keep their pre-ticket-04 behavior — dedicated suites exercise the real
     * limits end-to-end.
     */
    rateLimits?: { enabled?: boolean };
  } = {},
): Promise<{
  nestApp: NestExpressApplication;
  expressApp: Express;
  /** The DB-backed Better Auth instance (server-side revocation, admin flows). */
  auth: ReturnType<typeof createAuth>;
  /** The process-wide in-memory limiter wired into the guard. */
  rateLimiter: RateLimiter;
  /** The trusted-proxy config used for client-IP derivation. */
  trustedIpConfig: TrustedIpConfig;
  /** The guarded pooled app_user connection for tenant work (ticket 05). */
  dbPool: Pool;
}> {
  const trustedIpConfig: TrustedIpConfig = trustedIpConfigFromValues(env);
  const rateLimiter = new RateLimiter();

  // Tenant pool: DATABASE_URL is the pooled app_user URL (supervisor
  // allowlist) — never the migrator URL. createPool installs the
  // tenant-query guard, so tenant tables are reachable only inside the
  // transaction wrappers' transactions.
  const dbPool = createPool(env.DATABASE_URL, { max: 10 });

  const auth = createAuth({
    databaseUrl: env.DATABASE_URL,
    appOrigin: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    emailProvider: options.emailProvider ?? resolveEmailProvider(env),
    pool: options.authPool,
    secureCookies: env.NODE_ENV === "production",
  });

  const nestApp = await NestFactory.create<NestExpressApplication>(
    AppModule.withAuth(auth, rateLimiter, dbPool),
    {
      logger: env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
    },
  );
  nestApp.setGlobalPrefix("v1");
  const expressApp = nestApp.getHttpAdapter().getInstance() as Express;

  expressApp.use(originGuard(env.APP_ORIGIN));
  expressApp.use(express.json({ limit: "64kb" }));
  expressApp.use(hopDiagnostics(trustedIpConfig));
  if (options.rateLimits?.enabled !== false) {
    expressApp.use(createRateLimitGuard(rateLimiter, trustedIpConfig));
  }
  expressApp.use(mountBetterAuth(auth));

  await nestApp.init();
  return { nestApp, expressApp, auth, rateLimiter, trustedIpConfig, dbPool };
}
