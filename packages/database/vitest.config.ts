import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // Boot the embedded Postgres substitute once per run (localhost:5433) and
    // tear it down afterwards. See docs/adr/0001-local-infra-substitutes.md.
    globalSetup: ["src/testing/vitest-global-setup.ts"],
    // Suites share one Postgres instance and run idempotent bootstrap steps —
    // keep them sequential to avoid role/schema creation races.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
