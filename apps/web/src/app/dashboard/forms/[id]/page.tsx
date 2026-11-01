import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { t } from "@form/i18n";
import type { FormBlock } from "@form/contracts";
import { getServerSession } from "../../../../lib/session";
import { getForm } from "../../../../lib/forms";
import RenameForm from "../../RenameForm";
import SaveDraftButton from "./SaveDraftButton";

/**
 * Form page shell (ticket 06) — read-only preview of the mutable draft.
 *
 * The server component validates the session (redirect when signed out),
 * then reads the form + draft from the internal API (GET /v1/forms/{id} with
 * the incoming cookie forwarded). A 404 — unknown id OR a form of another
 * workspace, deliberately indistinguishable — renders Next's not-found page.
 *
 * What renders where (spec data model):
 * - `forms.name` is the DASHBOARD label (with the inline rename control);
 * - the respondent-facing title is the draft envelope's `title`, which the
 *   builder (ticket 08) edits; M0's empty draft shows the "Untitled form"
 *   placeholder;
 * - the draft's blocks render read-only, with the ticket-07 minimal SAVE
 *   control (full-envelope PUT through the same-origin rewrite); this slice
 *   has no block editing, no publish controls, and no public page
 *   (tickets 08/09).
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

  const title = form.draft.schema.title.trim() || t("dashboard.forms.untitled");

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <p>
        <Link href="/dashboard">{t("dashboard.forms.backToDashboard")}</Link>
      </p>

      <h1>{title}</h1>
      <p>
        <strong>{t("dashboard.forms.title")}:</strong> {form.name}{" "}
        <span style={{ color: "#555" }}>({form.status})</span>
      </p>
      <RenameForm formId={form.id} currentName={form.name} />
      <p>
        <strong>{t("dashboard.forms.draftLabel")}:</strong>{" "}
        {t("dashboard.forms.draftVersion", {
          version: form.draft.draftVersion,
        })}
      </p>
      {/* Ticket 07: the minimal save path (builder editing is ticket 08). */}
      <p>
        <SaveDraftButton
          formId={form.id}
          draftVersion={form.draft.draftVersion}
          schema={form.draft.schema}
        />
      </p>

      <Blocks blocks={form.draft.schema.blocks} />
    </main>
  );
}

/** Read-only preview of the draft's blocks (creator text is React-escaped). */
function Blocks(props: { blocks: FormBlock[] }) {
  if (props.blocks.length === 0) {
    return (
      <section>
        <h2>{t("dashboard.forms.blocksHeading")}</h2>
        <p>{t("dashboard.forms.blocksEmpty")}</p>
      </section>
    );
  }

  return (
    <section>
      <h2>{t("dashboard.forms.blocksHeading")}</h2>
      <ol style={{ padding: 0 }}>
        {props.blocks.map((block) => (
          <li key={block.id} style={{ padding: "0.5rem 0" }}>
            <BlockPreview block={block} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function BlockPreview(props: { block: FormBlock }) {
  const { block } = props;
  const kindLabel =
    block.kind === "welcome"
      ? t("dashboard.forms.block.welcome")
      : block.kind === "ending"
        ? t("dashboard.forms.block.ending")
        : block.kind === "short_text"
          ? t("dashboard.forms.block.shortText")
          : t("dashboard.forms.block.longText");

  return (
    <div
      style={{ border: "1px solid #eee", padding: "0.75rem", borderRadius: 4 }}
    >
      <span style={{ color: "#555" }}>{kindLabel}</span>
      {block.kind === "welcome" || block.kind === "ending" ? (
        <>
          <p>
            <strong>{block.title}</strong>
          </p>
          {block.description ? <p>{block.description}</p> : null}
        </>
      ) : (
        <>
          <p>
            <strong>{block.label}</strong>{" "}
            <span style={{ color: "#555" }}>
              (
              {block.required
                ? t("dashboard.forms.question.required")
                : t("dashboard.forms.question.optional")}
              )
            </span>
          </p>
          {block.description ? <p>{block.description}</p> : null}
        </>
      )}
    </div>
  );
}
