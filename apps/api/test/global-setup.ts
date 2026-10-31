import type { GlobalSetupContext } from "vitest/node";
import { ensureEmbeddedPostgres, stopEmbeddedPostgres } from "@form/database/testing";

/**
 * Boots the embedded Postgres substitute once per apps/api test run and tears
 * it down afterwards (reuse-aware: a server already listening is kept).
 */
export default async function globalSetup(
  _context?: GlobalSetupContext,
): Promise<(() => Promise<void>) | void> {
  const { started } = await ensureEmbeddedPostgres();
  if (!started) return;
  return async () => {
    await stopEmbeddedPostgres();
  };
}
