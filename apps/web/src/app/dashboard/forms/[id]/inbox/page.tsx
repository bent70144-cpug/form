import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../../../../lib/session";
import { getForm } from "../../../../../lib/forms";
import { listSubmissions } from "./readers";

/**
 * Per-form submission inbox (ticket 11) — the LIST page at
 * /dashboard/forms/{id}/inbox.
 *
 * The server component validates the session (redirect when signed out),
 * then reads the form (a 404 — unknown id OR another workspace's form,
 * deliberately indistinguishable — renders Next's not-found page) and ONE
 * page of submissions, newest first, through the internal API. Each row
 * links to the detail view and shows the received time plus the first-answer
 * preview (or the i18n fallback); pagination follows the API's opaque
 * `nextCursor`. Every label, empty state, date prefix and error comes from
 * the i18n catalog — no hardcoded copy. CSV export and analytics are NOT
 * part of this slice (spec).
 */
export default async function InboxListPage(props: {
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
      <p>{form.name}</p>

      {page === null ? (
        <p role="alert">{t("dashboard.inbox.loadFailed")}</p>
      ) : submissions.length === 0 ? (
        <p>{t("dashboard.inbox.empty")}</p>
      ) : (
        <>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {submissions.map((submission) => (
              <li
                key={submission.id}
                style={{ padding: "0.5rem 0", borderTop: "1px solid #eee" }}
              >
                <Link href={`/dashboard/forms/${id}/inbox/${submission.id}`}>
                  {t("dashboard.inbox.submittedAt", {
                    date: new Date(submission.submittedAt).toISOString(),
                  })}
                </Link>
                <div style={{ color: "#555" }}>
                  {submission.preview ??
                    t("dashboard.inbox.previewEmpty")}{" "}
                  ·{" "}
                  {t("dashboard.inbox.formVersion", {
                    version: submission.formVersionNumber,
                  })}
                </div>
              </li>
            ))}
          </ul>
          {page.nextCursor ? (
            <p>
              <Link
                href={`/dashboard/forms/${id}/inbox?cursor=${encodeURIComponent(page.nextCursor)}`}
              >
                {t("dashboard.inbox.nextPage")}
              </Link>
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}
