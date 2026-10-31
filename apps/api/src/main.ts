import "reflect-metadata";
import { createApiApp } from "./app";

/**
 * API entrypoint (supervisor-spawned, internal port). The public port is
 * served by Next.js; browsers reach this process only through the Next.js
 * `/v1/*` rewrite or server-side calls to API_INTERNAL_URL.
 */
async function bootstrap() {
  const { nestApp, close } = await createApiApp();
  const port = Number(process.env.PORT ?? 4000);
  await nestApp.listen(port, "0.0.0.0");
  process.stdout.write(
    JSON.stringify({ event: "api.listening", port }) + "\n",
  );
  // Release the request-path tenant pool on shutdown (SIGTERM on Render).
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
}

bootstrap().catch((err) => {
  process.stderr.write(`[api] ${err?.stack ?? err}\n`);
  process.exit(1);
});
