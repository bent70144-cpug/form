import { createLogger, loadEnv, workerEnvSchema } from "@form/config";
import { createHeartbeatWorker } from "./worker";

/**
 * Worker entrypoint (spec: "One documented command starts web, API, and
 * worker; the worker logs a heartbeat").
 */
const env = loadEnv(workerEnvSchema);
const logger = createLogger({ name: "worker", level: env.LOG_LEVEL });

const worker = createHeartbeatWorker({ logger });
const heartbeatLogger = logger;

void worker.start().then(() => {
  // The in-memory adapter runs enqueued jobs inline, so the recurring beat is
  // a plain interval until pg-boss provides persistence (tickets 02/05).
  const timer = setInterval(() => {
    void worker.queue
      .enqueue("heartbeat", { at: new Date().toISOString() })
      .catch((error: unknown) =>
        heartbeatLogger.error({ err: error }, "heartbeat enqueue failed"),
      );
  }, env.HEARTBEAT_INTERVAL_MS);

  const shutdown = (signal: string) => {
    clearInterval(timer);
    heartbeatLogger.info({ signal }, "worker shutting down");
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
});
