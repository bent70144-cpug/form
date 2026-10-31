"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";

/**
 * Workspace bootstrap trigger (ticket 05). Rendered by the dashboard when
 * `GET /v1/auth/session` reports `workspace: null`.
 *
 * - Client component ONLY: bootstrap is a state-changing POST through the
 *   browser's same-origin `/v1/*` rewrite (the Origin guard has no
 *   internal-call exemption, so a server component could not call it — the
 *   spec requires this flow to run in the browser).
 * - Fires once per mount via an effect guard (React strict mode double-
 *   render safe), shows "Setting up your workspace…", then refreshes the
 *   server components so the dashboard renders with the new workspace.
 * - The endpoint is idempotent, so even an accidental double call cannot
 *   create duplicates.
 */
export default function BootstrapWorkspace() {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void bootstrap();
  }, []);

  async function bootstrap() {
    setError(false);
    setRetrying(true);
    try {
      const res = await fetch("/v1/workspaces/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      // Refresh the server components: the session now carries the workspace.
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section aria-busy={!error} style={{ marginTop: 8 }}>
      {!error ? (
        <p role="status">{t("dashboard.bootstrap.settingUp")}</p>
      ) : (
        <>
          <p role="alert" style={{ color: "#b00020" }}>
            {t("dashboard.bootstrap.failed")}
          </p>
          <button type="button" onClick={() => void bootstrap()} disabled={retrying}>
            {retrying ? t("common.loading") : t("dashboard.bootstrap.retry")}
          </button>
        </>
      )}
    </section>
  );
}
