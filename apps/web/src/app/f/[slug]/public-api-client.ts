import { publicFormResponseSchema, type PublicFormResponse } from "@form/contracts";
import { internalApiUrl } from "../../../lib/internal-api";

/**
 * Server-side reader for the public form page (ticket 09) — the /f/[slug]
 * half of the public slice.
 *
 * The web app has NO database access (spec): the SSR page fetches the
 * UNauthenticated `GET /v1/public/forms/{slug}` on the INTERNAL API URL
 * (never through the public domain or the /v1 rewrite). No cookies are
 * forwarded — the endpoint is cookie-less by design (a future password gate
 * sits in front of it; session creation is ticket 10's separate
 * resolve_public_form path).
 *
 * - `redirect: "manual"` so the API's 308 (superseded slug) reaches the page
 *   as data — the page turns it into a permanentRedirect to /f/{canonical}.
 * - `cache: "no-store"` on every fetch, matching the API's no-store posture
 *   (unpublish/republish must take effect immediately).
 * - Responses are parsed through the shared contract so drift fails loudly.
 * - Network/parse failures and 404s both map to `{ status: "not_found" }` —
 *   a respondent sees 404, never a stack trace.
 */
export type FetchedPublicForm = PublicFormResponse;

export async function fetchPublicForm(
  slug: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<FetchedPublicForm> {
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(
      `${internalApiUrl()}/v1/public/forms/${encodeURIComponent(slug)}`,
      { redirect: "manual", cache: "no-store" },
    );
  } catch {
    return { status: "not_found" };
  }

  if (res.status === 308) {
    const location = res.headers.get("location") ?? "";
    const canonical = location.replace(/^\/f\//, "");
    const parsed = publicFormResponseSchema.safeParse({
      status: "redirect",
      canonicalSlug: canonical,
    });
    return parsed.success ? parsed.data : { status: "not_found" };
  }

  if (res.status !== 200) return { status: "not_found" };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { status: "not_found" };
  }
  const parsed = publicFormResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : { status: "not_found" };
}
