import type { GlobalSetupContext } from "vitest/node";
/**
 * Vitest globalSetup: boots the embedded Postgres once per test run on
 * localhost:5433 and tears it down afterwards. If a server is already
 * listening (dev supervisor / `pnpm db:start`), it is reused and NOT stopped.
 */
export default function globalSetup(_context?: GlobalSetupContext): Promise<(() => Promise<void>) | void>;
//# sourceMappingURL=vitest-global-setup.d.ts.map