import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

/**
 * Browser availability probe (ticket 11's sandbox guard).
 *
 * The E2E suite is the spec's seam 1 (primary acceptance), but this
 * environment may lack the Chromium SYSTEM libraries (no sudo —
 * `playwright install --with-deps` cannot run). The probe launches Chromium
 * ONCE here and records the outcome in `.browser-status.json`; every spec
 * file then does `test.skip(!browserAvailable(), reason)` so the whole
 * project degrades to a clean skip instead of a red run when the browser
 * cannot start. The API/web seams (embedded-PG + supertest + Vitest) still
 * cover the behavior in that case.
 */
export default async function globalSetup(): Promise<void> {
  const statusFile = path.join(__dirname, ".browser-status.json");
  const status: { ok: boolean; reason: string } = { ok: false, reason: "" };
  try {
    const browser = await chromium.launch();
    await browser.close();
    status.ok = true;
  } catch (error) {
    status.reason = String(error instanceof Error ? error.message : error).slice(0, 500);
    process.stderr.write(
      `[e2e] chromium could not start — specs will SKIP. Reason: ${status.reason}\n` +
        `[e2e] install the missing system libraries (playwright install-deps chromium) to run the browser seam.\n`,
    );
  }
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
}
