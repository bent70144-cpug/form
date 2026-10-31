import { createLogger, loadEnv, webEnvSchema } from "@form/config";
import { createWebServer } from "./server";

/**
 * Web entrypoint. Only public variables reach this process (the supervisor
 * spawn allowlist strips DATABASE_URL/auth secrets); the Zod schema here is
 * the fail-fast guardrail for the public slice of the environment.
 */
const env = loadEnv(webEnvSchema);
const logger = createLogger({ name: "web", level: env.LOG_LEVEL });

const server = createWebServer({ apiInternalUrl: env.API_INTERNAL_URL });

server.listen(env.PORT, "127.0.0.1", () => {
  logger.info({ port: env.PORT }, "web listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "web shutting down");
    server.close(() => process.exit(0));
  });
}
