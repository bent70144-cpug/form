import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en, t } from "@form/i18n";
import { formatReceivedAt } from "../src/lib/submissions";

/**
 * Ticket 11 — the submission inbox UI wiring.
 *
 * Behavioral guarantees (cursor pagination, pinned-version pairing,
 * cross-workspace 404s) are proven at the API seam
 * (apps/api/test/submissions.test.ts) and the database seam
 * (packages/database/test/submissions-rls.test.ts). The browser happy path
 * is proven by the Playwright suite (e2e). Here we pin the pure pieces and
 * the source-level wiring rules: server-side reads on the INTERNAL API with
 * the cookie forwarded (never the browser rewrite), escaped plain text
 * (no dangerouslySetInnerHTML), and every string through the i18n catalog.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

const LIST_PAGE = "src/app/dashboard/forms/[id]/submissions/page.tsx";
const DETAIL_PAGE = "src/app/dashboard/forms/[id]/submissions/[sid]/page.tsx";

/** Both pages sit under Next's route segments — imports reach src/lib by relative depth. */
const LIB_IMPORT = /from "(\.\.\/)+lib\/(session|submissions)"/;

describe("formatReceivedAt", () => {
  it("renders a deterministic UTC 'YYYY-MM-DD HH:MM UTC' stamp", () => {
    expect(formatReceivedAt("2026-11-01T09:07:08.123Z")).toBe(
      "2026-11-01 09:07 UTC",
    );
    expect(formatReceivedAt("2026-01-02T23:59:00.000Z")).toBe(
      "2026-01-02 23:59 UTC",
    );
  });

  it("falls back to the raw string for non-ISO input", () => {
    expect(formatReceivedAt("not-a-date")).toBe("not-a-date");
  });
});

describe("i18n catalog (dashboard.inbox)", () => {
  it("carries every inbox key the pages render", () => {
    for (const key of [
      "title",
      "open",
      "empty",
      "receivedAt",
      "versionBadge",
      "backToForm",
      "backToInbox",
      "detailTitle",
      "unknownQuestion",
      "morePages",
      "loadFailed",
    ] as const) {
      expect(
        (en.dashboard.inbox as Record<string, unknown>)[key],
        `dashboard.inbox.${key}`,
      ).toBeTypeOf("string");
    }
  });

  it("resolves the interpolated strings through t()", () => {
    expect(t("dashboard.inbox.receivedAt", { date: "2026-11-01 09:07 UTC" })).toBe(
      "Received 2026-11-01 09:07 UTC",
    );
    expect(t("dashboard.inbox.versionBadge", { version: 3 })).toBe(
      "Form version 3",
    );
    expect(t("dashboard.inbox.empty")).toContain("No submissions yet");
  });
});

describe("inbox page wiring", () => {
  it("both inbox pages read through the server-side lib (internal API + cookie)", () => {
    for (const rel of [LIST_PAGE, DETAIL_PAGE]) {
      const src = readWebSource(rel);
      expect(src).toMatch(LIB_IMPORT);
      expect(src).toContain("lib/submissions");
      expect(src).toContain("getServerSession()");
      // Signed-out/revoked sessions redirect on the next request.
      expect(src).toContain('redirect("/sign-in?next=%2Fdashboard")');
      // No browser-rewrite fetches in server components.
      expect(src).not.toContain('fetch("/v1/');
    }
  });

  it("the inbox renders escaped plain text — no dangerouslySetInnerHTML prop", () => {
    for (const rel of [LIST_PAGE, DETAIL_PAGE]) {
      expect(readWebSource(rel)).not.toContain("dangerouslySetInnerHTML=");
    }
    // And the whole web app keeps that rule too (creator text is data).
    const libSubmissions = readWebSource("src/lib/submissions.ts");
    expect(libSubmissions).not.toContain("dangerouslySetInnerHTML=");
  });

  it("the detail page renders pairs (label + answer) from the contract data", () => {
    const src = readWebSource(DETAIL_PAGE);
    expect(src).toContain("submission.answers.map");
    expect(src).toContain("{pair.label");
    expect(src).toContain("{pair.answer}");
    expect(src).toContain("dashboard.inbox.unknownQuestion");
  });

  it("the list page renders the empty state, version badges and cursor paging", () => {
    const src = readWebSource(LIST_PAGE);
    expect(src).toContain("dashboard.inbox.empty");
    expect(src).toContain("dashboard.inbox.versionBadge");
    expect(src).toContain("dashboard.inbox.morePages");
    expect(src).toContain("encodeURIComponent(page.nextCursor)");
    expect(src).toContain("dashboard.inbox.loadFailed");
  });

  it("the form page links to the inbox through the catalog key", () => {
    const src = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(src).toContain("dashboard.inbox.open");
    expect(src).toContain("/submissions");
  });

  it("the shared submissions lib targets the inbox API routes on the internal URL", () => {
    const src = readWebSource("src/lib/submissions.ts");
    expect(src).toContain("`/v1/forms/${formId}/submissions");
    expect(src).toContain("internalApiUrl()");
    expect(src).toContain('cache: "no-store"');
    expect(src).toContain("listSubmissionsResponseSchema.safeParse");
    expect(src).toContain("submissionDetailSchema.safeParse");
  });
});
