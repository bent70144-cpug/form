import { apiEnvSchema, loadEnv, createLogger } from "@form/config";
import { createDatabaseCheck } from "./db-check";
import { createHttpServer } from "./app";

/**
 * API entrypoint. Environment is Zod-validated and startup fails fast on
 * missing/invalid values (spec: "environment configuration is Zod-validated
 * and fails at startup on missing or invalid values").
 */
const env = loadEnv(apiEnvSchema);
const logger = createLogger({ name: "api", level: env.LOG_LEVEL });

const server = createHttpServer({
  checkDatabase: createDatabaseCheck(env.DATABASE_URL),
  logger,
});

server.listen(env.PORT, "127.0.0.1", () => {
  logger.info({ port: env.PORT }, "api listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "api shutting down");
    server.close(() => process.exit(0));
  });
}
