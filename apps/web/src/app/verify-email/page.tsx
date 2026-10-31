import { t } from "@form/i18n";
import ResendVerificationForm from "./ResendVerificationForm";

/**
 * Verify-email landing page — the callbackURL Better Auth redirects to after
 * the emailed link. Next.js server component (searchParams is a Promise in
 * Next 15+/16). `?error=…` marks an invalid/expired token; anything else is
 * the success path. Includes the enumeration-safe resend control.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = params.error;
  const failed = typeof error === "string" && error.length > 0;

  return (
    <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto" }}>
      <h1>{t("auth.verifyEmail.title")}</h1>
      {failed ? (
        <p role="alert" style={{ color: "#b00020" }}>
          {t("auth.verifyEmail.failed")}
        </p>
      ) : (
        <p role="status" style={{ color: "#0a7d32" }}>
          {t("auth.verifyEmail.success")}
        </p>
      )}
      <ResendVerificationForm />
      <p style={{ marginTop: 16 }}>{t("auth.verifyEmail.resendHere")}</p>
      <p>
        <a href="/sign-in">{t("auth.verifyEmail.backToSignIn")}</a>
      </p>
    </main>
  );
}
