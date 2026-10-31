import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  // NestJS DI relies on decorator type metadata, which esbuild does not emit;
  // SWC with `decoratorMetadata` keeps constructor injection working in tests.
  plugins: [
    swc.vite({
      module: { type: "es6" },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // Boot the embedded Postgres substitute once per run (localhost:5433).
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
