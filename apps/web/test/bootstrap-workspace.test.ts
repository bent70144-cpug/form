import { describe, expect, it, vi } from "vitest";
import { bootstrapWorkspace } from "../src/lib/bootstrap-workspace";
import { en } from "@form/i18n";

/**
 * Ticket 05 — the dashboard bootstrap stepper's browser call.
 *
 * The client component (`BootstrapWorkspace.tsx`) wires this helper into
 * useEffect; the unit test pins the wire behavior (idempotent POST through
 * the same-origin /v1 rewrite, same-origin credentials). The server
 * component never calls it. E2E hook: the component exposes
 * `[data-testid="workspace-bootstrap"]` (role="status") so an automated
 * browser can await the "Setting up your workspace…" state before the
 * router.refresh() swap — see the component's doc comment.
 */

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      workspace: { id: "00000000-0000-7000-8000-000000000000", name: "Personal Workspace", role: "owner" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("bootstrapWorkspace (dashboard client call)", () => {
  it("POSTs /v1/workspaces/bootstrap with same-origin credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse());
    await expect(bootstrapWorkspace({ fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/v1/workspaces/bootstrap");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
  });

  it("reports failure for problem responses (e.g. 403 email_unverified)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ type: "https://form.example/errors/email_unverified", status: 403 }),
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    );
    await expect(bootstrapWorkspace({ fetchImpl })).resolves.toBe(false);
  });

  it("propagates network errors so the component can show the retry hint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    await expect(bootstrapWorkspace({ fetchImpl })).rejects.toThrow("network down");
  });

  it("uses the catalog strings the component renders (no hardcoded copy)", () => {
    expect(en.dashboard.settingUpWorkspace).toBe("Setting up your workspace…");
    expect(typeof en.dashboard.bootstrapFailed).toBe("string");
  });
});
