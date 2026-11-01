import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Shared E2E helpers (ticket 11) — the browser-side equivalents of the API
 * fixtures' mail-sink helpers, plus the accessibility seam.
 *
 * The dev SMTP sink (the decided Mailpit substitute) exposes its mailbox over
 * REST at GET /dev/mailbox (default http://127.0.0.1:5434 — override with
 * SINK_HTTP_URL or SINK_HTTP_PORT; the supervisor's sink child owns it).
 */

export const SINK_HTTP_URL =
  process.env.SINK_HTTP_URL ??
  `http://127.0.0.1:${process.env.SINK_HTTP_PORT ?? 5434}/dev/mailbox`;

export interface SinkMessage {
  id: number;
  to: string[];
  raw: string;
}

async function sinkFetch(init?: RequestInit): Promise<Response> {
  const res = await fetch(SINK_HTTP_URL, init);
  if (!res.ok) {
    throw new Error(`mail sink ${SINK_HTTP_URL} answered ${res.status}`);
  }
  return res;
}

export async function clearMailbox(): Promise<void> {
  await sinkFetch({ method: "DELETE" });
}

export async function readMailbox(): Promise<SinkMessage[]> {
  const res = await sinkFetch();
  const body = (await res.json()) as { messages?: SinkMessage[] };
  return body.messages ?? [];
}

/** Polls the sink until a mail TO the address arrives (or times out). */
export async function waitForMailTo(to: string, timeoutMs = 20_000): Promise<SinkMessage> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const messages = await readMailbox();
      const found = messages.find((m) => m.to.some((t) => t.includes(to)));
      if (found) return found;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `no mail delivered to ${to} within ${timeoutMs}ms${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}

/** Extracts Better Auth's verification URL from a raw mail body. */
export function extractVerificationUrl(rawMail: string): string {
  const match = rawMail.match(/https?:\/\/\S+\/v1\/auth\/verify-email\?token=\S+/);
  if (!match) {
    throw new Error(`no verification URL in mail body: ${rawMail.slice(0, 400)}`);
  }
  return match[0].replace(/["\s]+$/, "");
}

/**
 * The accessibility seam (spec "Testing Decisions" seam 1): axe scans on
 * sign-in, the dashboard form list, the builder, the submission list and
 * detail, and the public form — FAILING the run on serious/critical
 * violations (moderate/minor are reported, not fatal, per ticket).
 */
export async function assertNoSeriousAxeViolations(
  page: Page,
  contextLabel: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const bad = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const summary = bad.map(
    (v) =>
      `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(" | ")}`,
  );
  expect(
    summary,
    `${contextLabel}: serious/critical axe violations`,
  ).toEqual([]);
}

/**
 * The 360px public-form seam: no horizontal scrolling at a 360px CSS width
 * (documentElement.scrollWidth must stay within 360 + tolerance).
 */
export async function assertNoHorizontalScroll(
  page: Page,
  cssWidth = 360,
  tolerance = 8,
): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(
    width,
    `public form scrolls horizontally at ${cssWidth}px (scrollWidth ${width})`,
  ).toBeLessThanOrEqual(cssWidth + tolerance);
}

/** Deterministic per-run addresses so re-runs never collide. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.example`;
}

/** Signs in through the UI and lands on the dashboard. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard");
}

/**
 * Waits for the builder's autosave to settle: at least one draft PUT has
 * answered AND the status has been "All changes saved" for a quiet window
 * (serialized saves queue edits behind the in-flight request).
 */
export async function waitForDraftSettled(page: Page): Promise<void> {
  await expect(page.getByRole("status")).toHaveText("All changes saved", {
    timeout: 20_000,
  });
  // A trailing queued save would flip the status back to "Saving…" — give it
  // a quiet window and re-check (at most a few rounds).
  for (let round = 0; round < 3; round++) {
    const stillSaved = await page.getByRole("status").evaluate(
      (el) =>
        new Promise<boolean>((resolve) => {
          window.setTimeout(() => resolve(el.textContent === "All changes saved"), 1200);
        }),
    );
    if (stillSaved) return;
    await expect(page.getByRole("status")).toHaveText("All changes saved", {
      timeout: 20_000,
    });
  }
}
