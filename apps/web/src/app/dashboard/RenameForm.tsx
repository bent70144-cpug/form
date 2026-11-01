"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";
import { renameDashboardForm } from "../../lib/forms-client";

/**
 * Dashboard rename control (ticket 06). PATCHes `/v1/forms/{id}` — the
 * DASHBOARD label (`forms.name`) only; the respondent-facing title lives in
 * the draft envelope and is edited by the builder (ticket 08). Client-side
 * because the PATCH is state-changing and must carry the browser's Origin
 * through the same-origin /v1/* rewrite.
 */
export default function RenameForm(props: {
  formId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState(props.currentName);

  async function onRename() {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === props.currentName) return;
    setBusy(true);
    setFailed(false);
    const ok = await renameDashboardForm(props.formId, trimmed);
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    // Refresh the server components (list + detail) with the new label.
    router.refresh();
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        aria-label={t("dashboard.forms.renameLabel")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={200}
        size={Math.max(10, Math.min(40, props.currentName.length + 2))}
      />
      <button type="button" onClick={onRename} disabled={busy}>
        {busy ? t("dashboard.forms.saving") : t("dashboard.forms.rename")}
      </button>
      {failed ? (
        <span role="alert" style={{ color: "#b00020" }}>
          {t("dashboard.forms.renameFailed")}
        </span>
      ) : null}
    </span>
  );
}
