import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ISSUE_CODES } from "@form/form-schema";
import { en } from "@form/i18n";
import { describeIssues } from "../src/lib/builder-issues";

/**
 * Ticket 08 — builder UI source contracts.
 *
 * Behavior is proven at the logic seam (reducer, saver, id generator — their
 * own test files). Here we pin the WIRING rules from the spec: the builder is
 * a client component under the T06 server shell, mutations go through the
 * same-origin /v1/* rewrite (never the internal API URL), client validation
 * runs the SHARED engine, reorder is keyboard-accessible (real move buttons;
 * drag is a bonus), a 409 swaps in the reload state, and every string is an
 * i18n key.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

describe("form page shell + builder wiring", () => {
  it("the page stays a server component: session → getForm → 404, then renders the client builder", () => {
    const page = readWebSource("src/app/dashboard/forms/[id]/page.tsx");
    expect(page).toContain("getServerSession");
    expect(page).toContain("getForm");
    expect(page).toContain("notFound()");
    expect(page).not.toContain('"use client"');
    // The draft envelope (respondent-facing title + blocks) is handed to the
    // builder client — the respondent-facing schema title is the envelope's
    // `title`, distinct from forms.name (T06 rename stays on this page).
    expect(page).toContain("form.draft.schema");
    expect(page).toContain("BuilderClient");
    expect(page).toContain("RenameForm");
    expect(page).toContain("initialDraftVersion={form.draft.draftVersion}");
  });

  it("the builder is a client component using the shared engine and saver", () => {
    const builder = readWebSource("src/app/dashboard/forms/[id]/BuilderClient.tsx");
    expect(builder).toContain('"use client"');
    expect(builder).toContain("validateDraftSchema");
    expect(builder).toContain("generateBlockId");
    expect(builder).toContain("createDraftSaver");
    expect(builder).toContain("builderReducer");
    expect(builder).toContain("describeIssues");
    // Add controls for all four M0 kinds — all real buttons.
    expect(builder).toContain('"welcome"');
    expect(builder).toContain('"short_text"');
    expect(builder).toContain('"long_text"');
    expect(builder).toContain('"ending"');
    expect(builder).toContain('type="button"');
    // Keyboard-accessible reorder (mandatory) + HTML5 drag (bonus).
    expect(builder).toContain("dashboard.builder.moveUp");
    expect(builder).toContain("dashboard.builder.moveDown");
    expect(builder).toContain("dashboard.builder.deleteBlock");
    expect(builder).toContain("draggable");
    expect(builder).toContain("onDragStart");
    expect(builder).toContain("onDrop");
    // 409 → reload state instead of overwriting; editing disabled meanwhile.
    expect(builder).toContain("window.location.reload()");
    expect(builder).toContain('disabled={conflict}');
    // No hardcoded issue copy: codes flow through describeIssues.
    expect(builder).not.toMatch(/label_too_long/);
  });

  it("draft saves are browser mutations through the same-origin rewrite only", () => {
    const saver = readWebSource("src/lib/builder-save.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(saver).toContain('method: "PUT"');
    expect(saver).toContain('credentials: "same-origin"');
    expect(saver).toContain("/v1/forms/");
    expect(saver).toContain("draftVersion");
    expect(saver).toContain("409");
    // Never the internal API URL (Origin guard has no internal-call exemption).
    expect(saver).not.toContain("internalApiUrl");
    const idGen = readWebSource("src/lib/builder-id.ts");
    expect(idGen).not.toMatch(/from\s+["']/); // dependency-free on purpose
  });
});

describe("i18n coverage for the builder", () => {
  it("every shared schema issue code resolves through the catalog", () => {
    const table = en.errors.schemaIssues as Record<string, string>;
    const missing = ISSUE_CODES.filter((code) => typeof table[code] !== "string");
    expect(missing).toEqual([]);
  });

  it("builder labels, states and conflict copy are catalog keys", () => {
    expect(typeof en.dashboard.builder.schemaTitleLabel).toBe("string");
    expect(en.dashboard.builder.schemaTitleLabel).not.toBe(
      en.dashboard.forms.renameLabel,
    );
    expect(typeof en.dashboard.builder.add.welcome).toBe("string");
    expect(typeof en.dashboard.builder.add.shortText).toBe("string");
    expect(typeof en.dashboard.builder.add.longText).toBe("string");
    expect(typeof en.dashboard.builder.add.ending).toBe("string");
    expect(en.dashboard.builder.moveUp).toContain("{name}");
    expect(en.dashboard.builder.status.saved).toContain("saved");
    expect(en.dashboard.builder.status.conflictHint.length).toBeGreaterThan(10);
  });

  it("describeIssues renders engine issues via catalog keys with paths", () => {
    const lines = describeIssues([
      { path: "blocks.0.label", code: "label_too_long" },
      { path: "", code: "schema_too_large" },
    ]);
    expect(lines[0]).toContain("blocks.0.label");
    expect(lines[0]).toContain(en.errors.schemaIssues.label_too_long);
    expect(lines[1]).toBe(en.errors.schemaIssues.schema_too_large);
  });
});
