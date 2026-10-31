"use client";

import { useState, type FormEvent } from "react";
import { t } from "@form/i18n";

/**
 * Resend-verification prompt — the spec's "dashboard shows a
 * resend-verification prompt" and the verify-email page's resend control.
 * Posts to the SAME-ORIGIN `/v1/auth/send-verification-email`; the endpoint
 * is enumeration-safe (identical generic response for known and unknown
 * addresses), so this UI always reports the same neutral "sent" message and
 * never reveals whether the address exists.
 */
export default function ResendVerificationForm({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/v1/auth/send-verification-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // 200 = generic accepted (known or unknown address — indistinguishable).
      setSent(res.ok);
      if (!res.ok) setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 16 }}>
      <p>{t("auth.resend.prompt")}</p>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, alignItems: "start" }}>
        <label style={{ display: "block", flex: 1 }}>
          {t("auth.signUp.emailLabel")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
        <button type="submit" disabled={busy} style={{ marginTop: 22 }}>
          {busy ? t("common.loading") : t("auth.resend.action")}
        </button>
      </form>
      {sent ? (
        <p role="status" style={{ color: "#0a7d32" }}>
          {t("auth.resend.sent")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {t("auth.errors.generic")}
        </p>
      ) : null}
    </section>
  );
}
