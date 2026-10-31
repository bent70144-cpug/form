import { ensureEmbeddedPostgres, stopEmbeddedPostgres } from "@form/database/testing";

/** Boots the shared embedded Postgres fixture for worker tests. */
export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const { started } = await ensureEmbeddedPostgres();
  if (!started) return;
  return async () => {
    await stopEmbeddedPostgres();
  };
}
