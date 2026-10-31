import { ensureEmbeddedPostgres, isPostgresReachable } from "../testing/embedded";

/**
 * `pnpm db:start` — boots the embedded Postgres substitute on 127.0.0.1:5433
 * and keeps it running until interrupted (SIGINT/SIGTERM stop it gracefully).
 * Safe to run when a server is already listening (it exits without error).
 */
async function main(): Promise<void> {
  if (await isPostgresReachable()) {
    process.stdout.write(
      `A Postgres server is already listening on 127.0.0.1:5433 — nothing to do.\n`,
    );
    return;
  }
  const { port, started } = await ensureEmbeddedPostgres();
  if (!started) {
    process.stdout.write(`Postgres became available on port ${port}.\n`);
    return;
  }
  process.stdout.write(
    [
      `Embedded Postgres running on 127.0.0.1:${port}`,
      `  data dir: ${"os" in globalThis ? "(see docs)" : ""}`,
      `  databases: form_dev, form_test (user: postgres)`,
      `Press Ctrl+C to stop.`,
      "",
    ].join("\n"),
  );
  const shutdown = () => {
    process.stdout.write("\nStopping embedded Postgres…\n");
    void stopAndExit();
  };
  async function stopAndExit(): Promise<never> {
    const { stopEmbeddedPostgres } = await import("../testing/embedded");
    await stopEmbeddedPostgres();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive for as long as Postgres runs.
  setInterval(() => undefined, 60_000);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `db:start failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
