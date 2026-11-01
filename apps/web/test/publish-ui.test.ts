import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en, t } from "@form/i18n";
import {
  buildPublicUrl,
  bytesAsKb,
  publishForm,
  publishIssueMessage,
  unpublishForm,
  worstCaseExceedsCap,
} from "../src/lib/publish";
import { resolveAppOrigin } from "../src/lib/app-origin";

/**
 * Ticket 09 — dashboard publish controls (source contracts + logic seams).
 *
 * The API slice (POST /v1/forms/{formId}/publish|unpublish) is ticket 09's
 * backend; here we pin the UI side: browser mutations through the SAME-ORIGIN
 * /v1/* rewrite (never the internal API URL), responses parsed through the
 * shared contracts, 422 stable codes → i18n messages (with fallback), the
 * copy-link URL built from the publish response's slug, the worst-case
 * warning condition, and every string through the catalog.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PUBLISH_OK = {
  formId: "018f0000-0000-7000-8000-000000000001",
  status: "published",
  versionId: "018f0000-0000-7000-8000-000000000002",
  versionNumber: 2,
  slug: "aB3xY9kQ0z",
  publishedAt: "2026-10-31T12:00:00.000Z",
  worstCaseBytes: 102400,
  submissionCapBytes: 102400,
};

describe("publish/unpublish browser calls (lib/publish.ts)", () => {
  it("publishForm POSTs the same-origin rewrite endpoint and parses the contract", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return jsonRes(200, PUBLISH_OK);
    }) as unknown as typeof fetch;

    const result = await publishForm(
      "018f0000-0000-7000-8000-000000000001",
      { fetchImpl },
    );

    expect(result.kind).toBe("published");
    if (result.kind === "published") {
      expect(result.response.slug).toBe("aB3xY9kQ0z");
      expect(result.response.versionNumber).toBe(2);
      expect(result.response.worstCaseBytes).toBe(102400);
      expect(result.response.submissionCapBytes).toBe(102400);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "/v1/forms/018f0000-0000-7000-8000-000000000001/publish",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  it("a drifted 200 body fails loudly as an error, not as a success", async () => {
    const fetchImpl = (async () =>
      jsonRes(200, { ...PUBLISH_OK, slug: "not-a-slug" })) as unknown as typeof fetch;
    const result = await publishForm("x", { fetchImpl });
    expect(result.kind).toBe("error");
  });

  it("422 publish-validation failures carry the stable codes", async () => {
    const fetchImpl = (async () =>
      jsonRes(422, {
        type: "https://form.example/problems/validation_failed",
        title: "Validation failed",
        status: 422,
        code: "validation_failed",
        errors: [
          { path: "blocks.0.label", code: "empty_label", message: "…" },
          { path: "", code: "no_question_blocks", message: "…" },
        ],
      })) as unknown as typeof fetch;

    const result = await publishForm("x", { fetchImpl });
    expect(result.kind).toBe("validation");
    if (result.kind === "validation") {
      expect(result.issues).toEqual([
        { path: "blocks.0.label", code: "empty_label" },
        { path: "", code: "no_question_blocks" },
      ]);
    }
  });

  it("a malformed 422 body degrades to zero issues — never a crash", async () => {
    const fetchImpl = (async () =>
      jsonRes(422, { nope: true })) as unknown as typeof fetch;
    const result = await publishForm("x", { fetchImpl });
    expect(result.kind).toBe("validation");
    expect(result.kind === "validation" && result.issues).toEqual([]);
  });

  it("non-ok (404/5xx) and network failures map to the generic error kind", async () => {
    const notFound = (async () =>
      jsonRes(404, { code: "not_found" })) as unknown as typeof fetch;
    expect((await publishForm("x", { fetchImpl: notFound })).kind).toBe("error");
    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect((await publishForm("x", { fetchImpl: boom })).kind).toBe("error");
  });

  it("unpublishForm POSTs /unpublish and only accepts a `closed` response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return jsonRes(200, {
        formId: "018f0000-0000-7000-8000-000000000001",
        status: "closed",
      });
    }) as unknown as typeof fetch;

    await expect(
      unpublishForm("018f0000-0000-7000-8000-000000000001", { fetchImpl }),
    ).resolves.toBe(true);
    expect(calls[0]!.url).toBe(
      "/v1/forms/018f0000-0000-7000-8000-000000000001/unpublish",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");

    const drifted = (async () =>
      jsonRes(200, { formId: "x", status: "published" })) as unknown as typeof fetch;
    await expect(unpublishForm("x", { fetchImpl: drifted })).resolves.toBe(false);
    const err = (async () =>
      jsonRes(404, { code: "not_found" })) as unknown as typeof fetch;
    await expect(unpublishForm("x", { fetchImpl: err })).resolves.toBe(false);
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(unpublishForm("x", { fetchImpl: down })).resolves.toBe(false);
  });
});

describe("publish UI logic", () => {
  it("buildPublicUrl makes {APP_ORIGIN}/f/{slug} and normalizes the origin", () => {
    expect(buildPublicUrl("https://form.example", "aB3xY9kQ0z")).toBe(
      "https://form.example/f/aB3xY9kQ0z",
    );
    expect(buildPublicUrl("https://form.example/", "aB3xY9kQ0z")).toBe(
      "https://form.example/f/aB3xY9kQ0z",
    );
    expect(buildPublicUrl("http://localhost:3000", "0000000000")).toBe(
      "http://localhost:3000/f/0000000000",
    );
  });

  it("the worst-case warning is strictly greater-than (equal caps stay silent)", () => {
    expect(worstCaseExceedsCap(102401, 102400)).toBe(true);
    expect(worstCaseExceedsCap(102400, 102400)).toBe(false);
    expect(worstCaseExceedsCap(0, 102400)).toBe(false);
  });

  it("bytes render as whole KB, rounded UP (never understate the risk)", () => {
    expect(bytesAsKb(102400)).toBe(100);
    expect(bytesAsKb(102401)).toBe(101);
    expect(bytesAsKb(1)).toBe(1);
  });

  it("422 codes render through the shared schemaIssues catalog with paths", () => {
    expect(
      publishIssueMessage({ path: "blocks.0.label", code: "empty_label" }),
    ).toBe(`blocks.0.label: ${en.errors.schemaIssues.empty_label}`);
    // Root path (no dot path) renders the bare message.
    expect(
      publishIssueMessage({ path: "", code: "no_question_blocks" }),
    ).toBe(en.errors.schemaIssues.no_question_blocks);
  });

  it("an unknown future code falls back to a generic message instead of throwing", () => {
    const fallback = t("dashboard.publish.issueFallback");
    // The path prefix is kept; the unknown code never crashes the render.
    expect(
      publishIssueMessage({ path: "blocks.3", code: "some_future_code" }),
    ).toBe(`blocks.3: ${fallback}`);
    expect(
      publishIssueMessage({ path: "", code: "some_future_code" }),
    ).toBe(fallback);
  });
});

describe("app-origin resolution (copy-link basis)", () => {
  it("prefers the proxy hop chain (x-forwarded-host, first proto entry)", () => {
    expect(
      resolveAppOrigin({
        forwardedHost: "form.example",
        host: "internal:3000",
        forwardedProto: "https, http",
      }),
    ).toBe("https://form.example");
    expect(resolveAppOrigin({ host: "form.example" })).toBe(
      "https://form.example",
    );
    expect(resolveAppOrigin({ host: "localhost:3000" })).toBe(
      "http://localhost:3000",
    );
  });

  it("falls back to NEXT_PUBLIC_APP_ORIGIN and normalizes trailing slashes", () => {
    expect(resolveAppOrigin({ envOrigin: "https://form.example/" })).toBe(
      "https://form.example",
    );
    expect(resolveAppOrigin({ host: "form.example/", envOrigin: "https://x" })).toBe(
      "https://form.example",
    );
    expect(resolveAppOrigin({})).toBeNull();
  });
});

describe("publish controls wiring (source contracts)", () => {
  it("the page renders the controls with the request-derived origin", () => {
    const page = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(page).toContain("PublishControls");
    expect(page).toContain("status={form.status}");
    expect(page).toContain("resolveAppOrigin");
    expect(page).toContain('"x-forwarded-host"');
    expect(page).toContain("NEXT_PUBLIC_APP_ORIGIN");
    // Still the T06 shell + T08 builder (no regressions).
    expect(page).toContain("getServerSession");
    expect(page).toContain("notFound()");
    expect(page).not.toContain('"use client"');
    expect(page).toContain("BuilderClient");
    expect(page).toContain("RenameForm");
  });

  it("the controls are a client component driven by lib/publish (same-origin only)", () => {
    const controls = readWebSource(
      "src/app/dashboard/forms/[id]/PublishControls.tsx",
    );
    expect(controls).toContain('"use client"');
    expect(controls).toContain("publishForm");
    expect(controls).toContain("unpublishForm");
    expect(controls).toContain("worstCaseExceedsCap");
    expect(controls).toContain("publishIssueMessage");
    expect(controls).toContain("navigator.clipboard");
    // All three statuses tracked client-side (server prop seeds the state).
    expect(controls).toContain("draft");
    expect(controls).toContain("published");
    expect(controls).toContain("closed");
    // Closed state message + persistent warning are announced.
    expect(controls).toContain('role="alert"');
    expect(controls).toContain('role="note"');
  });

  it("mutations never touch the internal API URL", () => {
    const lib = readWebSource("src/lib/publish.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(lib).toContain('method: "POST"');
    expect(lib).toContain('credentials: "same-origin"');
    expect(lib).toContain("/v1/forms/");
    expect(lib).toContain("publishResponseSchema");
    expect(lib).toContain("unpublishResponseSchema");
    expect(lib).not.toContain("internalApiUrl");
  });
});

describe("i18n coverage for the publish controls", () => {
  it("every dashboard.publish key resolves through t()", () => {
    const keys = [
      "dashboard.publish.statusLabel",
      "dashboard.publish.status.draft",
      "dashboard.publish.status.published",
      "dashboard.publish.status.closed",
      "dashboard.publish.publishedVersion",
      "dashboard.publish.publish",
      "dashboard.publish.publishing",
      "dashboard.publish.republish",
      "dashboard.publish.republishing",
      "dashboard.publish.unpublish",
      "dashboard.publish.unpublishing",
      "dashboard.publish.publishFailed",
      "dashboard.publish.unpublishFailed",
      "dashboard.publish.validationHeading",
      "dashboard.publish.issueFallback",
      "dashboard.publish.closedMessage",
      "dashboard.publish.publicLinkHeading",
      "dashboard.publish.copyLink",
      "dashboard.publish.copied",
      "dashboard.publish.openPublicPage",
      "dashboard.publish.worstCaseWarning",
    ] as const;
    for (const key of keys) {
      expect(typeof t(key)).toBe("string");
      expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it("interpolation placeholders are present and substituted", () => {
    expect(en.dashboard.publish.publishedVersion).toContain("{version}");
    expect(
      t("dashboard.publish.publishedVersion", { version: 3 }),
    ).toContain("3");
    expect(en.dashboard.publish.worstCaseWarning).toContain("{worst}");
    expect(en.dashboard.publish.worstCaseWarning).toContain("{cap}");
    const warning = t("dashboard.publish.worstCaseWarning", {
      worst: 101,
      cap: 100,
    });
    expect(warning).toContain("101");
    expect(warning).toContain("100");
  });

  it("status labels are distinct and the closed note mentions republishing", () => {
    const { draft, published, closed } = en.dashboard.publish.status;
    expect(new Set([draft, published, closed]).size).toBe(3);
    expect(en.dashboard.publish.closedMessage).toMatch(/epublish/i);
  });
});
