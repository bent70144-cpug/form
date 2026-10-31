"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@form/i18n";

/**
 * Sign-out control. Posts to the SAME-ORIGIN `/v1/auth/sign-out` (the
 * browser's Origin header satisfies the API's global Origin guard), then
 * sends the visitor to /sign-in. Server-side revocation means the session
 * cookie is worthless afterwards even if a redirect were intercepted.
 */
export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function onSignOut() {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/v1/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
      if (!res.ok && res.status !== 401) setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <>
      <button type="button" onClick={onSignOut} disabled={busy}>
        {busy ? t("common.loading") : t("auth.signOut.action")}
      </button>
      {error ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {t("auth.errors.generic")}
        </p>
      ) : null}
    </>
  );
}
