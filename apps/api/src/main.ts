import "reflect-metadata";
import { createApiApp } from "./app";

/**
 * API entrypoint (supervisor-spawned, internal port). The public port is
 * served by Next.js; browsers reach this process only through the Next.js
 * `/v1/*` rewrite or server-side calls to API_INTERNAL_URL.
 */
async function bootstrap() {
  const { nestApp } = await createApiApp();
  const port = Number(process.env.PORT ?? 4000);
  await nestApp.listen(port, "0.0.0.0");
  process.stdout.write(
    JSON.stringify({ event: "api.listening", port }) + "\n",
  );
}

bootstrap().catch((err) => {
  process.stderr.write(`[api] ${err?.stack ?? err}\n`);
  process.exit(1);
});
