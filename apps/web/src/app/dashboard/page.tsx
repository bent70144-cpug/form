import { redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../lib/session";
import SignOutButton from "./SignOutButton";
import BootstrapWorkspace from "./BootstrapWorkspace";
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
 * Workspace bootstrap (ticket 05): when the session has no workspace yet,
 * the shell renders a small CLIENT component that POSTs
 * /v1/workspaces/bootstrap through the browser's same-origin /v1/* rewrite,
 * shows "Setting up your workspace…", and refreshes into the dashboard.
 * Bootstrap is NEVER called from a server component — the Origin guard has
 * no internal-call exemption, by design.
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
      ) : session.workspace ? (
        <>
          <p>
            <strong>{t("dashboard.workspace.label")}:</strong>{" "}
            {session.workspace.name}{" "}
            <span style={{ color: "#555" }}>({session.workspace.role})</span>
          </p>
          <p>{t("dashboard.placeholderNote")}</p>
        </>
      ) : (
        // Verified but not yet bootstrapped: the client component triggers
        // POST /v1/workspaces/bootstrap, then refreshes into the dashboard.
        <BootstrapWorkspace />
      )}

      <p style={{ marginTop: 24 }}>
        <SignOutButton />
      </p>
    </main>
  );
}
