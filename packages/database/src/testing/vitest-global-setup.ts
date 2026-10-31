import {
  ensureEmbeddedPostgres,
  stopEmbeddedPostgres,
} from "./embedded";

/**
 * Vitest globalSetup: boots the embedded Postgres once per test run on
 * localhost:5433 and tears it down afterwards. If a server is already
 * listening (dev supervisor / `pnpm db:start`), it is reused and NOT stopped.
 */
export default async function globalSetup(): Promise<
  (() => Promise<void>) | void
> {
  const { started } = await ensureEmbeddedPostgres();
  if (!started) return;
  return async () => {
    await stopEmbeddedPostgres();
  };
}
