import { defineConfig } from "@playwright/test";
import path from "node:path";

/**
 * Playwright E2E (ticket 11) — the spec's PRIMARY acceptance seam.
 *
 * The webServer boots the FULL supervisor stack exactly as `pnpm dev` does:
 * embedded Postgres (5433) + one-time bootstrap + migrations + pg-boss DDL +
 * the dev SMTP sink (smtp 1025 / REST 5434) + NestJS API (4000) + worker +
 * Next.js web (3000). Playwright tears the whole tree down with SIGTERM on
 * exit (the supervisor and the embedded-postgres child both stop gracefully).
 *
 * Sandbox constraints honored here: ONE worker (3.6 GB RAM), chromium ONLY
 * (disk), no webkit/firefox projects, and `reuseExistingServer` so an
 * already-running dev stack is reused instead of double-spawned.
 */
export default defineConfig({
  testDir: path.join(__dirname, "tests"),
  // One worker: the serial happy path shares server-side state (account,
  // form, submission) and the sandbox is RAM-constrained.
  workers: 1,
  fullyParallel: false,
  // Next dev compiles each route on first request — give the flow room.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "results.xml" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 720 },
    navigationTimeout: 90_000,
    actionTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/supervisor.mjs --dev",
    cwd: path.resolve(__dirname, ".."),
    url: "http://localhost:3000",
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
