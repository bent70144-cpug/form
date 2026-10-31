"use client";

import { useState, type FormEvent } from "react";
import { t } from "@form/i18n";
import { PASSWORD_LIMITS } from "@form/auth/password";

/**
 * Sign-up form. Posts to the SAME-ORIGIN `/v1/auth/sign-up/email` (browser
 * fetch carries the Origin header for the API's global Origin guard; the
 * browser never talks to the internal API URL). Enumeration-safe by
 * contract: an existing address returns the SAME generic success shape, so
 * the UI shows the identical "check your inbox" notice either way — no
 * user-existence signal exists client- or server-side.
 *
 * Password limits come from the shared policy constants (@form/auth/password,
 * the same values the API enforces and ticket 04's reset reuses).
 */
export default function SignUpForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorKey, setErrorKey] = useState<null | "passwordPolicy" | "generic">(null);
  const [sentTo, setSentTo] = useState<null | string>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    try {
      const res = await fetch("/v1/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (res.ok) {
        // Generic success — identical for new AND existing addresses.
        setSentTo(email);
        return;
      }
      let code = "";
      try {
        code = String((await res.json())?.code ?? "");
      } catch {
        code = "";
      }
      setErrorKey(code.startsWith("PASSWORD_TOO") ? "passwordPolicy" : "generic");
    } catch {
      setErrorKey("generic");
    } finally {
      setBusy(false);
    }
  }

  const labelStyle = { display: "block", marginBottom: 4 } as const;

  if (sentTo !== null) {
    return (
      <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
        <h1>{t("auth.signUp.checkInboxTitle")}</h1>
        <p>{t("auth.signUp.checkInboxBody", { email: sentTo })}</p>
        <p>
          <a href="/verify-email">{t("auth.verifyEmail.title")}</a>
          {" · "}
          <a href="/sign-in">{t("auth.signIn.title")}</a>
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 360, margin: "0 auto" }}>
      <h1>{t("auth.signUp.title")}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          {t("auth.signUp.nameLabel")}
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
        </label>
        <label style={labelStyle}>
          {t("auth.signUp.emailLabel")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
        </label>
        <label style={labelStyle}>
          {t("auth.signUp.passwordLabel")}
          <input
            type="password"
            required
            minLength={PASSWORD_LIMITS.min}
            maxLength={PASSWORD_LIMITS.max}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", marginBottom: 4 }}
          />
        </label>
        <p style={{ margin: "0 0 12px", color: "#555" }}>
          {t("auth.passwordPolicyHint", { min: PASSWORD_LIMITS.min, max: PASSWORD_LIMITS.max })}
        </p>
        {errorKey ? (
          <p role="alert" style={{ color: "#b00020" }}>
            {t(`auth.errors.${errorKey}`, { min: PASSWORD_LIMITS.min, max: PASSWORD_LIMITS.max })}
          </p>
        ) : null}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? t("common.loading") : t("auth.signUp.submit")}
        </button>
      </form>
      <p>
        {t("auth.signUp.haveAccount")}{" "}
        <a href="/sign-in">{t("auth.signUp.switchToSignIn")}</a>
      </p>
    </main>
  );
}
