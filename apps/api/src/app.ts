import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Express } from "express";
import type { Pool } from "pg";
import { createAuth, resolveEmailProvider } from "@form/auth/server";
import { AppModule } from "./app.module";
import { spikeHopRecorder } from "./health.controller";
import { mountBetterAuth } from "./auth/mount";
import { originGuard } from "./common/origin-guard";
import { loadApiEnv } from "./env";

/**
 * Builds the API app without listening (shared by `main.ts` and the
 * integration tests). Order matters — the Origin guard must run BEFORE both
 * the mounted Better Auth handler and the Nest controllers (spec: "a global
 * Nest guard enforces that all state-changing calls originate in the
 * browser through the same-origin /v1/* rewrite"):
 *
 *   1. spikeHopRecorder   — records the hop Nest sees (removed in ticket 04)
 *   2. originGuard        — 403 `origin_mismatch` for state-changing requests
 *   3. Better Auth mount  — /v1/auth/* (prefix preserved, see mount.ts;
 *                           /v1/auth/session falls through to Nest)
 *   4. Nest router        — /v1/health, /v1/auth/session, /v1/probe/*, future
 *                           /v1 endpoints
 */
export async function createApiApp(
  env = loadApiEnv(),
  options: { authPool?: Pool; emailProvider?: ReturnType<typeof resolveEmailProvider> } = {},
): Promise<{
  nestApp: NestExpressApplication;
  expressApp: Express;
  /** The DB-backed Better Auth instance (server-side revocation, admin flows). */
  auth: ReturnType<typeof createAuth>;
}> {
  const auth = createAuth({
    databaseUrl: env.DATABASE_URL,
    appOrigin: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    emailProvider: options.emailProvider ?? resolveEmailProvider(env),
    pool: options.authPool,
    secureCookies: env.NODE_ENV === "production",
  });

  const nestApp = await NestFactory.create<NestExpressApplication>(
    AppModule.withAuth(auth),
    {
      logger: env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
    },
  );
  nestApp.setGlobalPrefix("v1");
  const expressApp = nestApp.getHttpAdapter().getInstance() as Express;

  expressApp.use(spikeHopRecorder);
  expressApp.use(originGuard(env.APP_ORIGIN));
  expressApp.use(mountBetterAuth(auth));

  await nestApp.init();
  return { nestApp, expressApp, auth };
}
