import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createDashboardForm,
  renameDashboardForm,
} from "../src/lib/forms-client";
import { en } from "@form/i18n";

/**
 * Ticket 06 — the dashboard form list + form page shell wiring.
 *
 * Behavioral guarantees (create/list/read/rename, tenancy 404s, draft
 * existence) are proven at the API seam (apps/api/test/forms.test.ts). Here
 * we pin the client-side wiring rules from the spec: mutations run in the
 * BROWSER through the same-origin `/v1/*` rewrite (Origin guard has no
 * internal-call exemption), read-only list/detail GETs run server-side on
 * the INTERNAL API URL, and every string comes from the i18n catalog.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createDashboardForm (browser mutation)", () => {
  it("POSTs /v1/forms with JSON body and same-origin credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(201, {
        id: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
        name: "Untitled form",
        status: "draft",
        projectId: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7c",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        draft: { draftVersion: 0, schema: { title: "" } },
      }),
    );
    const created = await createDashboardForm({ fetchImpl });
    expect(created.ok).toBe(true);
    expect(created.formId).toBe("018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/v1/forms");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
  });

  it("reports failure for problem responses (403/422) and network errors", async () => {
    const problem = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: "origin_mismatch" }), { status: 403 }),
    );
    expect(await createDashboardForm({ fetchImpl: problem })).toEqual({
      ok: false,
      formId: null,
    });

    const networkDown = vi.fn<typeof fetch>(async () => {
      throw new Error("down");
    });
    expect(await createDashboardForm({ fetchImpl: networkDown })).toEqual({
      ok: false,
      formId: null,
    });
  });
});

describe("renameDashboardForm (browser mutation)", () => {
  it("PATCHes /v1/forms/{id} — the dashboard label only — with the new name", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        id: "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
        name: "Client intake",
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const ok = await renameDashboardForm(
      "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b",
      "Client intake",
      { fetchImpl },
    );
    expect(ok).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/v1/forms/018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b");
    expect(init?.method).toBe("PATCH");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Client intake" });
  });

  it("reports failure for problem responses (404 cross-tenant, 422)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ code: "not_found" }),
        { status: 404, headers: { "content-type": "application/problem+json" } },
      ),
    );
    await expect(
      renameDashboardForm("018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b", "x", { fetchImpl }),
    ).resolves.toBe(false);
  });
});

describe("dashboard source contracts (ticket 06)", () => {
  it("mutations are client components calling the same-origin lib helpers", () => {
    for (const component of [
      "src/app/dashboard/NewFormButton.tsx",
      "src/app/dashboard/RenameForm.tsx",
    ]) {
      const source = readWebSource(component);
      expect(source).toContain('"use client"');
      expect(source).toContain("router");
    }
    // No mutation URL leaks into server components: the SSR readers only GET.
    const serverReader = readWebSource("src/lib/forms.ts");
    const code = serverReader
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("internalApiUrl()");
    expect(code).not.toMatch(/method:\s*"(POST|PATCH)"/);
  });

  it("the dashboard lists forms and links to the form page shell", () => {
    const page = readWebSource("src/app/dashboard/page.tsx");
    expect(page).toContain("getServerSession");
    expect(page).toContain("listForms");
    expect(page).toContain("NewFormButton");
    expect(page).toContain("/dashboard/forms/");
  });

  it("the form page renders the draft and 404s unknown/cross-workspace ids", () => {
    const formPage = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(formPage).toContain("getServerSession");
    expect(formPage).toContain("getForm");
    expect(formPage).toContain("notFound()");
    // The respondent-facing title comes from the draft envelope's `title`,
    // while the dashboard label (with the rename control) is forms.name.
    expect(formPage).toContain("draft.schema.title");
    expect(formPage).toContain("RenameForm");
  });

  it("uses the catalog strings (no hardcoded copy)", () => {
    expect(en.dashboard.forms.newForm).toBe("New form");
    expect(en.dashboard.forms.untitled).toBe("Untitled form");
    expect(typeof en.dashboard.forms.createFailed).toBe("string");
    expect(typeof en.dashboard.forms.renameFailed).toBe("string");
    expect(en.dashboard.forms.draftVersion).toContain("{version}");
  });
});
