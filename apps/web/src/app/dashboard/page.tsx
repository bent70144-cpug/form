import { redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../lib/session";
import SignOutButton from "./SignOutButton";
import ResendVerificationForm from "../verify-email/ResendVerificationForm";

/**
 * Protected dashboard shell (spec: "The protected dashboard shell redirects
 * signed-out visitors; a revoked session redirects on the next request").
 *
 * The session is validated SERVER-SIDE on every request: getServerSession()
 * calls GET /v1/auth/session on the INTERNAL API URL with the incoming
 * cookie forwarded, wrapped in React cache() (one call per render). Null →
 * signed-out/invalid/revoked → redirect to /sign-in. middleware.ts never
 * authorizes anything (cookie-presence only, not a security boundary).
 *
 * Unverified users DO reach the dashboard here (they may sign in), but every
 * workspace/form/submission API route rejects them with 403
 * `email_unverified` — the shell shows the resend-verification prompt.
 */
export default async function DashboardPage() {
  const session = await getServerSession();
  if (!session) {
    // Signed-out, invalid, or revoked (401 empty-body) → redirect.
    redirect("/sign-in?next=%2Fdashboard");
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <h1>{t("dashboard.title")}</h1>
      <p>{t("dashboard.signedInAs", { email: session.email })}</p>

      {!session.emailVerified ? (
        <section
          role="alert"
          style={{
            border: "1px solid #b00020",
            padding: "1rem",
            borderRadius: 4,
          }}
        >
          <ResendVerificationForm initialEmail={session.email} />
        </section>
      ) : (
        <p>{t("dashboard.placeholderNote")}</p>
      )}

      <p style={{ marginTop: 24 }}>
        <SignOutButton />
      </p>
    </main>
  );
}
