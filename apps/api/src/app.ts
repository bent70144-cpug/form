import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Express } from "express";
import type { Pool } from "pg";
import { AppModule } from "./app.module";
import { spikeHopRecorder } from "./health.controller";
import { createAuth } from "./auth/auth";
import { mountBetterAuth } from "./auth/mount";
import { loadApiEnv } from "./env";

/**
 * Builds the API app without listening (shared by `main.ts` and the
 * integration tests). Order matters:
 *
 *   1. spikeHopRecorder   — records the hop Nest sees (removed in ticket 04)
 *   2. Better Auth mount  — /v1/auth/* (prefix preserved, see mount.ts)
 *   3. Nest router        — /v1/health and future /v1 endpoints
 */
export async function createApiApp(
  env = loadApiEnv(),
  options: { authPool?: Pool } = {},
): Promise<{
  nestApp: NestExpressApplication;
  expressApp: Express;
}> {
  const nestApp = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
  });
  nestApp.setGlobalPrefix("v1");
  const expressApp = nestApp.getHttpAdapter().getInstance() as Express;

  expressApp.use(spikeHopRecorder);
  expressApp.use(
    mountBetterAuth(
      createAuth({
        databaseUrl: env.DATABASE_URL,
        appOrigin: env.APP_ORIGIN,
        secret: env.BETTER_AUTH_SECRET,
        pool: options.authPool,
      }),
    ),
  );

  await nestApp.init();
  return { nestApp, expressApp };
}
