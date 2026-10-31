"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";
import { bootstrapWorkspace } from "../../lib/bootstrap-workspace";

/**
 * Workspace bootstrap stepper (ticket 05 checklist): rendered by the
 * dashboard SERVER component when `GET /v1/auth/session` reports
 * `workspace: null` — but the POST itself happens HERE, in the browser,
 * through the same-origin `/v1/*` rewrite. Server components never call
 * bootstrap (spec: "bootstrap is never called from a server component").
 *
 * Shows "Setting up your workspace…" while the idempotent POST runs, then
 * `router.refresh()` re-renders the shell, which now sees the active
 * workspace in the session. Failures surface a reload hint instead of
 * spinning forever; the endpoint is idempotent, so retrying is safe.
 *
 * E2E hook: `[data-testid="workspace-bootstrap"]` — the pending/failed
 * status node an automated browser can await before asserting the
 * refreshed dashboard.
 */
export default function BootstrapWorkspace() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    bootstrapWorkspace()
      .then((ok) => {
        if (cancelled) return;
        if (ok) {
          // The workspace now exists; re-render so the server component
          // picks up the populated session (this component unmounts).
          router.refresh();
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <p role="status" data-testid="workspace-bootstrap">
      {failed ? t("dashboard.bootstrapFailed") : t("dashboard.settingUpWorkspace")}
    </p>
  );
}
