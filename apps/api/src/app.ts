import "reflect-metadata";
import { createHmac } from "node:crypto";
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
 *   6. Draft-save parser  — PUT /v1/forms/{id}/draft gets its own explicit
 *                           300 KB JSON body parser (ticket 07)
 *   7. Nest router        — /v1/health, /v1/auth/session, /v1/probe/*, future
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
  close: () => Promise<void>;
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
    AppModule.withAuth(auth, rateLimiter, dbPool, {
      trustedIpConfig,
      // Ticket 10: HMAC key for the stored session ip_hash. IP_HASH_SECRET is
      // the production value; in dev/test the auth secret keys the HMAC so
      // the stored value is still keyed (never a bare reversible hash).
      ipHashSecret: env.IP_HASH_SECRET ?? createHmac("sha256", env.BETTER_AUTH_SECRET).update("ip-hash-key").digest("hex"),
      submissionCap: env.FORM_SUBMISSION_CAP,
    }),
    {
      logger: env.NODE_ENV === "test" ? false : ["log", "warn", "error"],
    },
  );
  nestApp.setGlobalPrefix("v1");
  const expressApp = nestApp.getHttpAdapter().getInstance() as Express;

  expressApp.use(originGuard(env.APP_ORIGIN));
  // Body parsing — EVERY limit is explicit, none inherited from an adapter
  // default (spec: "Draft-save route body limits are set explicitly at about
  // 300 KB; other routes use small explicit limits"). The global parser stays
  // at 64 KB (auth mount + all small routes), but the draft-save PUT must not
  // hit it (it would 413 a ~300 KB body before the route's own parser could
  // run), so the global parser is wrapped to skip exactly that route.
  const DRAFT_SAVE_ROUTE = /^\/v1\/forms\/[^/]+\/draft$/;
  const SUBMIT_ROUTE = /^\/v1\/public\/submissions$/;
  const globalJson = express.json({ limit: "64kb" });
  const draftSaveJson = express.json({ limit: "300kb" });
  // Ticket 10: the submit route carries its own explicit ~150 KB parser
  // (spec: "the submit route body limit is about 150 KB" — the 100 KB JSON
  // cap governs before per-field maxima would).
  const submitJson = express.json({ limit: "150kb" });
  expressApp.use((req, res, next) => {
    if (req.method === "PUT" && DRAFT_SAVE_ROUTE.test(req.path)) return next();
    if (req.method === "POST" && SUBMIT_ROUTE.test(req.path)) return next();
    globalJson(req, res, next);
  });
  expressApp.use(hopDiagnostics(trustedIpConfig));
  if (options.rateLimits?.enabled !== false) {
    expressApp.use(createRateLimitGuard(rateLimiter, trustedIpConfig));
  }
  expressApp.use(mountBetterAuth(auth));

  // Ticket 07: the draft-save route carries its OWN 300 KB parser, registered
  // BEFORE the Nest router (it parses the body, then next()s into Nest's
  // FormsController). body-parser skips already-parsed bodies, so this is the
  // only parser that ever touches a draft-save request. The 300 KB value is
  // the configured limit the tests assert (≈301 KB → 413, 250 KB → validated).
  expressApp.put("/v1/forms/:formId/draft", draftSaveJson);
  // Ticket 10: same pattern for the submit route (parse first, then next()
  // into Nest's PublicSubmissionController).
  expressApp.post("/v1/public/submissions", submitJson);

  await nestApp.init();
  // Graceful shutdown: stop accepting connections, close the DB pool so the
  // worker/supervisor can drain cleanly (SIGTERM/SIGINT in main.ts).
  const close = async (): Promise<void> => {
    await nestApp.close();
    await dbPool.end();
  };
  return { nestApp, expressApp, auth, rateLimiter, trustedIpConfig, dbPool, close };
}
