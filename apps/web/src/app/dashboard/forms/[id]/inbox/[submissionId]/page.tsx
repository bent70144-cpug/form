import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../../../../../lib/session";
import { getForm } from "../../../../../../lib/forms";
import { getSubmissionDetail } from "../readers";
import { pairAnswersWithBlocks } from "../pairing";

/**
 * Submission detail (ticket 11) — /dashboard/forms/{id}/inbox/{submissionId}.
 *
 * Each answer renders BESIDE its question label from the PINNED form
 * version (the version the respondent actually saw — never the current
 * draft), together with the received time and the form version number.
 * Labels and answers render as ESCAPED PLAIN TEXT: React text nodes only,
 * no dangerouslySetInnerHTML anywhere in the inbox. An unknown/cross-
 * workspace submission id renders the i18n not-found state inline (404 and
 * 404 are deliberately indistinguishable — no enumeration).
 */
export default async function SubmissionDetailPage(props: {
  params: Promise<{ id: string; submissionId: string }>;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in?next=%2Fdashboard");
  }

  const { id, submissionId } = await props.params;
  const form = await getForm(id);
  if (!form) {
    notFound();
  }

  const detail = await getSubmissionDetail(id, submissionId);
  if (!detail) {
    return (
      <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
        <p>
          <Link href={`/dashboard/forms/${id}/inbox`}>
            {t("dashboard.inbox.backToForm")}
          </Link>
        </p>
        <h1>{t("dashboard.inbox.title")}</h1>
        <p role="alert">{t("dashboard.inbox.notFound")}</p>
      </main>
    );
  }

  const paired = pairAnswersWithBlocks(
    detail.pinnedSchema,
    detail.submission.answers,
  );

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <p>
        <Link href={`/dashboard/forms/${id}/inbox`}>
          {t("dashboard.inbox.backToForm")}
        </Link>
      </p>

      <h1>{t("dashboard.inbox.submissionIdLabel")}</h1>
      <p>
        {t("dashboard.inbox.submittedAt", {
          date: new Date(detail.submission.submittedAt).toISOString(),
        })}{" "}
        ·{" "}
        {t("dashboard.inbox.formVersion", {
          version: detail.submission.formVersion.versionNumber,
        })}
      </p>

      <section>
        <h2>{t("dashboard.inbox.answersHeading")}</h2>
        <dl style={{ margin: 0 }}>
          {paired.map((row) => (
            <div
              key={row.blockId}
              style={{
                padding: "0.5rem 0",
                borderTop: "1px solid #eee",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.5rem",
              }}
            >
              <dt style={{ minWidth: 200, flex: "1 1 200px", margin: 0 }}>
                {row.label}
                {row.isQuestion && row.required
                  ? ` (${t("dashboard.forms.question.required")})`
                  : ""}
              </dt>
              <dd style={{ flex: "2 1 300px", margin: 0 }}>
                {row.answer ?? t("dashboard.inbox.noAnswer")}
                {!row.isQuestion ? (
                  <div style={{ color: "#555" }}>
                    {t("dashboard.inbox.unknownAnswer")}
                  </div>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
