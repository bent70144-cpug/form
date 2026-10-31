import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { t } from "@form/i18n";

/**
 * Ticket 05 — the dashboard's workspace-bootstrap flow. These are
 * source-contract checks (the same style as auth-ui.test.ts): the behavioral
 * guarantee (idempotent bootstrap, verified-email boundary, origin guard) is
 * proven at the API seam; here we pin the client-side wiring rules from the
 * spec — bootstrap is a CLIENT component calling the same-origin /v1/*
 * rewrite, never a server-component call, and the session GET never writes.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

describe("dashboard workspace bootstrap (ticket 05)", () => {
  it("bootstrap is a client component posting through the same-origin /v1 rewrite", () => {
    const source = readWebSource("src/app/dashboard/BootstrapWorkspace.tsx");
    expect(source).toContain('"use client"');
    expect(source).toContain('fetch("/v1/workspaces/bootstrap"');
    expect(source).toContain('"POST"');
    expect(source).toContain("credentials: \"same-origin\"");
    expect(source).toContain("router.refresh()");
    // The i18n key must resolve (catches catalog drift).
    expect(t("dashboard.bootstrap.settingUp")).toContain("Setting up your workspace");
    expect(t("dashboard.bootstrap.failed").length).toBeGreaterThan(0);
    expect(t("dashboard.bootstrap.retry").length).toBeGreaterThan(0);
  });

  it("the dashboard renders the bootstrap component ONLY when session.workspace is null", () => {
    const page = readWebSource("src/app/dashboard/page.tsx");
    expect(page).toContain("BootstrapWorkspace");
    expect(page).toContain("session.workspace");
    expect(page).toContain("getServerSession");
    // The page itself must never fetch the bootstrap endpoint server-side
    // (comments excluded — the docblock explains the flow).
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("workspaces/bootstrap");
  });

  it("the dashboard shows the workspace name and role once present", () => {
    const page = readWebSource("src/app/dashboard/page.tsx");
    expect(page).toContain("session.workspace.name");
    expect(page).toContain("session.workspace.role");
  });
});
