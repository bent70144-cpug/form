import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import { getServerSession } from "../../../../lib/session";
import { getForm } from "../../../../lib/forms";
import { resolveAppOrigin } from "../../../../lib/app-origin";
import RenameForm from "../../RenameForm";
import BuilderClient from "./BuilderClient";
import PublishControls from "./PublishControls";

/**
 * Form page — T06 shell + the T08 builder + the T09 publish controls.
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
 *   the same-origin /v1/* rewrite with optimistic `draft_version` (T07 API);
 * - the publish controls (ticket 09) render the status / published version,
 *   the Publish / Republish / Unpublish buttons and the copy-link action;
 *   they track their own client-side status after each mutation. The public
 *   origin for {APP_ORIGIN}/f/{slug} is derived from the incoming request
 *   headers (proxy hop chain) with NEXT_PUBLIC_APP_ORIGIN as fallback.
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

  const requestHeaders = await headers();
  const appOrigin =
    resolveAppOrigin({
      forwardedHost: requestHeaders.get("x-forwarded-host"),
      host: requestHeaders.get("host"),
      forwardedProto: requestHeaders.get("x-forwarded-proto"),
      envOrigin: process.env.NEXT_PUBLIC_APP_ORIGIN,
    }) ?? "";

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <p>
        <Link href="/dashboard">{t("dashboard.forms.backToDashboard")}</Link>
      </p>

      <h1>{form.name}</h1>
      <p>
        <RenameForm formId={form.id} currentName={form.name} />
      </p>
      <p>
        <strong>{t("dashboard.forms.draftLabel")}:</strong>{" "}
        {t("dashboard.forms.draftVersion", {
          version: form.draft.draftVersion,
        })}
      </p>

      <PublishControls formId={form.id} status={form.status} appOrigin={appOrigin} />

      <p>
        <Link href={`/dashboard/forms/${form.id}/submissions`}>
          {t("dashboard.inbox.open")}
        </Link>
      </p>

      <BuilderClient
        formId={form.id}
        initialSchema={form.draft.schema}
        initialDraftVersion={form.draft.draftVersion}
      />
    </main>
  );
}
