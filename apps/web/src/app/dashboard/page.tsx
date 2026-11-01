import { redirect } from "next/navigation";
import Link from "next/link";
import { t } from "@form/i18n";
import { getServerSession } from "../../lib/session";
import { listForms } from "../../lib/forms";
import SignOutButton from "./SignOutButton";
import BootstrapWorkspace from "./BootstrapWorkspace";
import NewFormButton from "./NewFormButton";
import RenameForm from "./RenameForm";
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
 *
 * Ticket 05: a verified user whose session has `workspace: null` gets the
 * small client bootstrap stepper. The server component itself never
 * triggers bootstrap (read-only session GET).
 *
 * Ticket 06: with a workspace present the shell lists the active
 * workspace's forms (labels from `forms.name`) with a client-side
 * "New form" button and inline rename; each row links to the form page
 * shell at /dashboard/forms/{id}. The list GET runs server-side on the
 * internal API (read-only); all mutations run in the browser.
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
        <FormsSection
          workspaceName={session.workspace.name}
          workspaceRole={session.workspace.role}
        />
      ) : (
        <BootstrapWorkspace />
      )}

      <p style={{ marginTop: 24 }}>
        <SignOutButton />
      </p>
    </main>
  );
}

/**
 * The form list (server component). The list GET runs server-side on the
 * internal API; a failed read renders the empty state rather than crashing
 * the shell.
 */
async function FormsSection(props: {
  workspaceName: string;
  workspaceRole: string;
}) {
  const page = await listForms();
  const forms = page?.forms ?? [];

  return (
    <section>
      <p>
        <strong>{t("dashboard.workspace.label")}:</strong> {props.workspaceName}{" "}
        <span style={{ color: "#555" }}>({props.workspaceRole})</span>
      </p>
      <h2>{t("dashboard.forms.title")}</h2>
      <p>
        <NewFormButton />
      </p>

      {forms.length === 0 ? (
        <p>{t("dashboard.forms.empty")}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {forms.map((form) => (
            <li
              key={form.id}
              style={{ padding: "0.5rem 0", borderTop: "1px solid #eee" }}
            >
              <div>
                <Link href={`/dashboard/forms/${form.id}`}>{form.name}</Link>{" "}
                <span style={{ color: "#555" }}>
                  {t("dashboard.forms.createdAt", {
                    date: new Date(form.createdAt).toISOString(),
                  })}
                </span>
              </div>
              <RenameForm formId={form.id} currentName={form.name} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
