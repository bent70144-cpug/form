import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../../../lib/session";
import { getForm } from "../../../../lib/forms";
import RenameForm from "../../RenameForm";
import BuilderClient from "./BuilderClient";

/**
 * Form page — T06 shell + the T08 builder.
 *
 * The server component validates the session (redirect when signed out),
 * then reads the form + draft from the internal API (GET /v1/forms/{id} with
 * the incoming cookie forwarded). A 404 — unknown id OR a form of another
 * workspace, deliberately indistinguishable — renders Next's not-found page.
 *
 * What renders where (spec data model):
 * - `forms.name` is the DASHBOARD label (with the inline rename control,
 *   ticket 06) — never respondent-facing;
 * - the respondent-facing title is the draft envelope's `title`, edited by
 *   the builder below (ticket 08) together with the M0 blocks;
 * - the builder is a CLIENT component: edits autosave the FULL draft through
 *   the same-origin /v1/* rewrite with optimistic `draft_version` (T07 API).
 */
export default async function FormPage(props: {
  params: Promise<{ id: string }>;
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

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <p>
        <Link href="/dashboard">{t("dashboard.forms.backToDashboard")}</Link>
      </p>

      <h1>{form.name}</h1>
      <p>
        <span style={{ color: "#555" }}>({form.status})</span>{" "}
        <RenameForm formId={form.id} currentName={form.name} />
      </p>
      <p>
        <strong>{t("dashboard.forms.draftLabel")}:</strong>{" "}
        {t("dashboard.forms.draftVersion", {
          version: form.draft.draftVersion,
        })}
      </p>

      <BuilderClient
        formId={form.id}
        initialSchema={form.draft.schema}
        initialDraftVersion={form.draft.draftVersion}
      />
    </main>
  );
}
