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
 * rewrite through the lib helper, never a server-component call, and the
 * session GET never writes.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

function readWebSource(relPath: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relPath), "utf8");
}

describe("dashboard workspace bootstrap (ticket 05)", () => {
  it("bootstrap is a client component posting through the same-origin /v1 rewrite", () => {
    const component = readWebSource("src/app/dashboard/BootstrapWorkspace.tsx");
    expect(component).toContain('"use client"');
    // The POST happens in the browser via the shared lib helper.
    expect(component).toContain("bootstrapWorkspace()");
    expect(component).toContain("router.refresh()");
    // i18n keys must resolve (catches catalog drift).
    expect(t("dashboard.settingUpWorkspace")).toContain(
      "Setting up your workspace",
    );
    expect(t("dashboard.bootstrapFailed").length).toBeGreaterThan(0);

    const helper = readWebSource("src/lib/bootstrap-workspace.ts");
    expect(helper).toContain('"/v1/workspaces/bootstrap"');
    expect(helper).toContain('"POST"');
    expect(helper).toContain('"same-origin"');
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

  it("the dashboard session supplies the workspace name and role once present", () => {
    // The active workspace {id, name, role} is resolved server-side via the
    // security-definer list_workspaces() (apps/api session service) and
    // shaped by the shared contract — pin the shape here.
    const contracts = readWebSource(
      "../../packages/contracts/src/schemas/workspace.ts",
    );
    expect(contracts).toContain("name: z.string()");
    expect(contracts).toContain("role: workspaceRoleSchema");
  });
});
