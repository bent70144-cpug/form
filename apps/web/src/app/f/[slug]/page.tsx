import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { t } from "@form/i18n";
import { fetchPublicForm } from "./public-api-client";
import { PublicFormClosed } from "./PublicFormView";
import PublicFormClient from "./PublicFormClient";

/**
 * Public form page /f/[slug] (tickets 09 + 10) — server-rendered, then
 * INTERACTIVE in the browser.
 *
 * The page NEVER touches the database (the web app has none): it calls the
 * UNauthenticated `GET /v1/public/forms/{slug}` on the INTERNAL API URL via
 * fetchPublicForm() and maps the four statuses onto responses:
 *
 *   published → the interactive client form (ticket 10): it creates the
 *               pinned session on mount (cookie-less POST through the /v1
 *               rewrite), collects answers, validates required questions
 *               client-side (convenience only — the server is authoritative),
 *               submits with X-Form-Session, and shows the ending block after
 *               the receipt; closed/expired submit failures show their
 *               dedicated messages
 *   closed    → the closed message (unpublished or soft-deleted form)
 *   redirect  → permanentRedirect(`/f/{canonicalSlug}`) — a 308 like the
 *               API's own redirect semantics
 *   not_found → notFound() — Next's 404 page
 *
 * `force-dynamic` keeps every render fresh with a no-store-class Cache-Control
 * on the HTML response (Next sends `private, no-cache, no-store, max-age=0,
 * must-revalidate` for dynamic renders), matching the API's `Cache-Control:
 * no-store`. The page is `noindex` (public pages are never indexed in M0).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: t("public.form.formTitleFallback"),
  robots: { index: false, follow: false },
};

export default async function PublicFormPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const result = await fetchPublicForm(slug);

  switch (result.status) {
    case "published":
      return (
        <PublicFormClient slug={slug} schema={result.schema} />
      );
    case "closed":
      return <PublicFormClosed />;
    case "redirect":
      // Superseded slug: a permanent (308) redirect to the canonical /f/{slug}.
      permanentRedirect(`/f/${result.canonicalSlug}`);
    case "not_found":
      // unknown slug, malformed slug, internal API down — all 404 to the
      // respondent; a closed form never lands here (see the API contract).
      notFound();
  }
}
