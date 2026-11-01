import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createDashboardForm,
  renameDashboardForm,
  saveDraftForm,
} from "../src/lib/forms-client";
import { emptyDraft } from "@form/form-schema";
import type { FormDraftSchema } from "@form/contracts";
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

describe("saveDraftForm (ticket 07 — browser draft save)", () => {
  const FORM_ID = "018f0b2e-6f7a-7c3e-9a1b-2c3d4e5f6a7b";
  const draft = (): { draftVersion: number; schema: FormDraftSchema } => ({
    draftVersion: 2,
    schema: emptyDraft() as FormDraftSchema,
  });

  it("PUTs the FULL envelope + last-seen draftVersion through the same-origin rewrite", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { draftVersion: 3 }),
    );
    const outcome = await saveDraftForm(FORM_ID, draft(), { fetchImpl });
    expect(outcome).toEqual({ ok: true, draftVersion: 3 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/v1/forms/${FORM_ID}/draft`);
    expect(init?.method).toBe("PUT");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(String(init?.body))).toEqual({
      schema: emptyDraft(),
      draftVersion: 2,
    });
  });

  it("short-circuits an invalid draft locally via the SHARED engine (no request)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const bad = draft();
    // Unknown field in a block — the shared engine rejects it (strict).
    bad.schema = {
      ...emptyDraft(),
      blocks: [
        {
          id: "abcdefghijk",
          kind: "short_text",
          label: "Name",
          required: false,
          notPartOfSchema: true,
        },
      ],
    } as unknown as FormDraftSchema;
    const outcome = await saveDraftForm(FORM_ID, bad, { fetchImpl });
    expect(outcome).toEqual({ ok: false, reason: "invalid_draft" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 409 draft_conflict to `conflict` and other problems to `failed`", async () => {
    const conflict = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ code: "draft_conflict" }),
        { status: 409, headers: { "content-type": "application/problem+json" } },
      ),
    );
    expect(await saveDraftForm(FORM_ID, draft(), { fetchImpl: conflict })).toEqual({
      ok: false,
      reason: "conflict",
    });

    const invalid = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: "validation_failed" }), { status: 422 }),
    );
    expect(await saveDraftForm(FORM_ID, draft(), { fetchImpl: invalid })).toEqual({
      ok: false,
      reason: "failed",
    });

    const networkDown = vi.fn<typeof fetch>(async () => {
      throw new Error("down");
    });
    expect(await saveDraftForm(FORM_ID, draft(), { fetchImpl: networkDown })).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("rejects a drifted success body (contract-parsed, not hand-shaped)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { draftVersion: 0 }), // version must be ≥ 1
    );
    expect(await saveDraftForm(FORM_ID, draft(), { fetchImpl })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

describe("dashboard source contracts (ticket 06)", () => {
  it("mutations are client components calling the same-origin lib helpers", () => {
    for (const component of [
      "src/app/dashboard/NewFormButton.tsx",
      "src/app/dashboard/RenameForm.tsx",
      "src/app/dashboard/forms/[id]/SaveDraftButton.tsx",
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

  it("the form page wires the ticket-07 minimal draft save (builder is T08)", () => {
    const formPage = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(formPage).toContain("SaveDraftButton");
    expect(formPage).toContain("draftVersion={form.draft.draftVersion}");
    expect(formPage).toContain("schema={form.draft.schema}");
  });

  it("the draft save consumes the SHARED contracts + engine (no duplicated rules)", () => {
    const client = readWebSource("src/lib/forms-client.ts");
    expect(client).toContain('from "@form/contracts"');
    expect(client).toContain('from "@form/form-schema"');
    expect(client).toContain("validateDraftSchema");
    expect(client).toContain("draftSaveRequestSchema");
    expect(client).toContain("draftSaveResponseSchema");
    // No copied rule constants: the engine owns IDs, limits and caps.
    expect(client).not.toMatch(/A-Za-z0-9_-/);
    expect(client).not.toMatch(/256\s*\*\s*1024|307200|64\s*\*\s*1024/);
  });

  it("uses the catalog strings (no hardcoded copy)", () => {
    expect(en.dashboard.forms.newForm).toBe("New form");
    expect(en.dashboard.forms.untitled).toBe("Untitled form");
    expect(typeof en.dashboard.forms.createFailed).toBe("string");
    expect(typeof en.dashboard.forms.renameFailed).toBe("string");
    expect(en.dashboard.forms.draftVersion).toContain("{version}");
    // Ticket 07 draft-save UI strings.
    expect(typeof en.dashboard.forms.save).toBe("string");
    expect(en.dashboard.forms.saved).toContain("{version}");
    expect(typeof en.dashboard.forms.saveFailed).toBe("string");
    expect(typeof en.dashboard.forms.saveConflict).toBe("string");
    expect(typeof en.dashboard.forms.saveInvalid).toBe("string");
  });
});
