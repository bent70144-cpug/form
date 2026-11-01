"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";
import type { FormDraftSchema } from "@form/contracts";
import { saveDraftForm } from "../../../../lib/forms-client";

/**
 * Draft save control (ticket 07) — the minimal save path that wires the
 * draft through the API. The BUILDER itself (block editing, add/remove,
 * reorder) is ticket 08; this button re-saves the draft AS LOADED with the
 * last-seen `draftVersion`, exercising the full round trip:
 *
 *   browser → same-origin /v1/* rewrite → PUT /v1/forms/{id}/draft
 *   (shared-contract request body; shared-engine pre-flight; 409 →
 *   reload prompt; success → router.refresh() shows the new version).
 *
 * Client-side because the PUT is state-changing and must carry the
 * browser's Origin (the API's Origin guard has no internal-call exemption).
 */
export default function SaveDraftButton(props: {
  formId: string;
  draftVersion: number;
  schema: FormDraftSchema;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [problem, setProblem] = useState<
    "conflict" | "invalid" | "failed" | null
  >(null);

  async function onSave() {
    setBusy(true);
    setSavedVersion(null);
    setProblem(null);
    const outcome = await saveDraftForm(props.formId, {
      draftVersion: props.draftVersion,
      schema: props.schema,
    });
    setBusy(false);
    if (outcome.ok) {
      setSavedVersion(outcome.draftVersion);
      // Re-render the server components (the page shell reads the draft
      // through GET /v1/forms/{id}) with the NEW version.
      router.refresh();
      return;
    }
    setProblem(
      outcome.reason === "conflict"
        ? "conflict"
        : outcome.reason === "invalid_draft"
          ? "invalid"
          : "failed",
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button type="button" onClick={onSave} disabled={busy}>
        {busy ? t("dashboard.forms.saving") : t("dashboard.forms.save")}
      </button>
      {savedVersion !== null ? (
        <span role="status" style={{ color: "#1b7f3b" }}>
          {t("dashboard.forms.saved", { version: savedVersion })}
        </span>
      ) : null}
      {problem !== null ? (
        <span role="alert" style={{ color: "#b00020" }}>
          {problem === "conflict"
            ? t("dashboard.forms.saveConflict")
            : problem === "invalid"
              ? t("dashboard.forms.saveInvalid")
              : t("dashboard.forms.saveFailed")}
        </span>
      ) : null}
    </span>
  );
}
