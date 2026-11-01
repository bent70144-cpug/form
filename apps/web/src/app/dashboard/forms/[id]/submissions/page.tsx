import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../../../../lib/session";
import { getForm } from "../../../../../lib/forms";
import { formatReceivedAt, listSubmissions } from "../../../../../lib/submissions";

/**
 * Submission inbox — the per-form LIST (ticket 11).
 *
 * Server component pattern of the dashboard (session redirect, form read on
 * the internal API with the cookie forwarded): a 404 on the FORM — unknown
 * id OR another workspace's form, deliberately indistinguishable — renders
 * Next's not-found page; the SUBMISSIONS read failing after a good form read
 * renders the i18n load-failed state instead of crashing the shell.
 *
 * Rows are newest-first (the API orders by (created_at, id) DESC) and show
 * the received time plus the form version the respondent saw, each linking
 * to the answer-beside-question detail. When the API reports another page,
 * an "Older submissions" link advances the opaque cursor (server-rendered
 * pagination; no client state).
 *
 * Labels/answers are DATA here (list level: none rendered) — detail text is
 * rendered by React as escaped plain text. All strings come from the i18n
 * catalog.
 */
export default async function SubmissionsPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in?next=%2Fdashboard");
  }

  const { id } = await props.params;
  const form = await getForm(id);
  if (!form) {
    notFound();
  }

  const { cursor } = await props.searchParams;
  const page = await listSubmissions(id, cursor);
  const submissions = page?.submissions ?? [];

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <p>
        <Link href={`/dashboard/forms/${id}`}>
          {t("dashboard.inbox.backToForm")}
        </Link>
      </p>

      <h1>{t("dashboard.inbox.title")}</h1>
      <p>
        <strong>{form.name}</strong>
      </p>

      {page === null ? (
        <p role="alert">{t("dashboard.inbox.loadFailed")}</p>
      ) : submissions.length === 0 ? (
        <p data-testid="inbox-empty">{t("dashboard.inbox.empty")}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }} data-testid="inbox-list">
          {submissions.map((submission) => (
            <li
              key={submission.id}
              style={{ padding: "0.5rem 0", borderTop: "1px solid #eee" }}
              data-testid="inbox-row"
            >
              <Link
                href={`/dashboard/forms/${id}/submissions/${submission.id}`}
              >
                {t("dashboard.inbox.receivedAt", {
                  date: formatReceivedAt(submission.createdAt),
                })}
              </Link>{" "}
              <span
                style={{ color: "#555" }}
                data-testid="inbox-row-version"
              >
                {t("dashboard.inbox.versionBadge", {
                  version: submission.formVersionNumber,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {page?.nextCursor ? (
        <p>
          <Link
            href={`/dashboard/forms/${id}/submissions?cursor=${encodeURIComponent(page.nextCursor)}`}
          >
            {t("dashboard.inbox.morePages")}
          </Link>
        </p>
      ) : null}
    </main>
  );
}
