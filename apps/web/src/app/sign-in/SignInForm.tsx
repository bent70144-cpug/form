"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { t } from "@form/i18n";

/**
 * Sign-in form. Posts to the SAME-ORIGIN `/v1/auth/sign-in/email` (the
 * browser's fetch carries the Origin header and Better Auth's session cookie
 * comes back first-party). Error messages come from the i18n catalog — the
 * single generic credential error (enumeration-safe) maps to one message.
 */
export default function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorKey, setErrorKey] = useState<null | "invalidCredentials" | "generic">(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    try {
      const res = await fetch("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.push(nextPath.startsWith("/") ? nextPath : "/dashboard");
        router.refresh();
        return;
      }
      setErrorKey(res.status === 401 ? "invalidCredentials" : "generic");
    } catch {
      setErrorKey("generic");
    } finally {
      setBusy(false);
    }
  }

  const labelStyle = { display: "block", marginBottom: 4 } as const;

  return (
    <main style={{ padding: "2rem", maxWidth: 360, margin: "0 auto" }}>
      <h1>{t("auth.signIn.title")}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          {t("auth.signIn.emailLabel")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
        </label>
        <label style={labelStyle}>
          {t("auth.signIn.passwordLabel")}
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
        </label>
        {errorKey ? (
          <p role="alert" style={{ color: "#b00020" }}>
            {t(`auth.errors.${errorKey}`)}
          </p>
        ) : null}
        <button type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? t("common.loading") : t("auth.signIn.submit")}
        </button>
      </form>
      <p>
        {t("auth.signIn.noAccount")}{" "}
        <a href="/sign-up">{t("auth.signIn.switchToSignUp")}</a>
      </p>
    </main>
  );
}
