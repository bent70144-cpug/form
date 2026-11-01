import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config (ticket 11 — spec seam 1, the browser seam).
 *
 * The webServer reuses the DEV STACK end-to-end (spec's one-command local
 * dev): scripts/supervisor.mjs --dev boots the embedded Postgres substitute,
 * the one-time admin bootstrap, migrations, the pg-boss schema install, the
 * dev mail sink (Mailpit substitute), the NestJS API, the worker and Next.js
 * — with the same per-child environment allowlists production uses. The
 * browser then drives the REAL hop chain: localhost:3000 (Next) → /v1/*
 * rewrite → NestJS → Postgres, and verification emails land in the sink's
 * REST mailbox (SINK_HTTP_PORT, default 5434).
 *
 * `reuseExistingServer` keeps local iteration cheap; CI always boots fresh.
 * Tests skip cleanly (see global-setup + helpers/browser.ts) when Chromium
 * cannot launch in the sandbox.
 */
const PORT = Number(process.env.WEB_PORT ?? 3000);

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    locale: "en-US",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../scripts/supervisor.mjs --dev",
    url: `http://127.0.0.1:${PORT}/sign-in`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
  },
});
