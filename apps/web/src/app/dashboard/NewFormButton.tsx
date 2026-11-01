"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";
import { createDashboardForm } from "../../lib/forms-client";

/**
 * "New form" trigger (ticket 06). A CLIENT component by design: creation is a
 * state-changing POST through the browser's same-origin `/v1/*` rewrite (the
 * API's global Origin guard has no internal-call exemption, so a server
 * component could not do this). On success the response is the created form
 * with its draft; we navigate straight into the form page shell.
 */
export default function NewFormButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onCreate() {
    setBusy(true);
    setFailed(false);
    const created = await createDashboardForm();
    setBusy(false);
    if (!created.ok || created.formId === null) {
      setFailed(true);
      return;
    }
    router.push(`/dashboard/forms/${created.formId}`);
  }

  return (
    <>
      <button type="button" onClick={onCreate} disabled={busy}>
        {busy ? t("dashboard.forms.creating") : t("dashboard.forms.newForm")}
      </button>
      {failed ? (
        <span role="alert" style={{ color: "#b00020" }}>
          {t("dashboard.forms.createFailed")}
        </span>
      ) : null}
    </>
  );
}
