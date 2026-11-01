/**
 * Publish mutations for the BROWSER (ticket 09) — the dashboard's
 * Publish / Republish / Unpublish controls.
 *
 * Both mutations are state-changing, so they go through the SAME-ORIGIN
 * `/v1/*` rewrite — never the internal API URL — carrying the browser's
 * Origin (the API's global guard requires a same-origin Origin; the server
 * components must NEVER import or call this module — same shape as
 * lib/forms-client.ts).
 *
 *   publishForm   POST /v1/forms/{formId}/publish   → 200 PublishResponse
 *                   (versionId/versionNumber/slug/publishedAt +
 *                    worstCaseBytes/submissionCapBytes) or 422 with the
 *                   shared schema engine's stable issue codes (nothing is
 *                   persisted) or 404 (unknown/cross-workspace form).
 *   unpublishForm POST /v1/forms/{formId}/unpublish → 200 UnpublishResponse
 *                   (status `closed`; republish reopens with a new version).
 *
 * Responses are parsed through the shared contracts so drift fails loudly.
 * The `fetchImpl` seam keeps the wire behavior unit-testable without a
 * browser (same pattern as bootstrapWorkspace / forms-client).
 */

import {
  publishResponseSchema,
  unpublishResponseSchema,
  type PublishResponse,
} from "@form/contracts";
import { en, t } from "@form/i18n";

/** One publish-validation issue as the API sends it (422 problem body). */
export interface PublishIssue {
  path: string;
  code: string;
}

export type PublishResult =
  | { kind: "published"; response: PublishResponse }
  /** 422 — stable engine codes; NOTHING was persisted server-side. */
  | { kind: "validation"; issues: PublishIssue[] }
  /** 404 / 5xx / network failure. */
  | { kind: "error" };

/** POST /v1/forms/{formId}/publish through the same-origin rewrite. */
export async function publishForm(
  formId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PublishResult> {
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/v1/forms/${formId}/publish`, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    return { kind: "error" };
  }
  if (res.status === 422) {
    // RFC 9457 problem: { code, errors: [{ path, code, message }] }. Only the
    // STABLE codes matter — messages are re-derived from i18n, never trusted.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const errors =
      typeof body === "object" && body !== null && "errors" in body
        ? (body as { errors?: unknown }).errors
        : null;
    const issues: PublishIssue[] = Array.isArray(errors)
      ? errors
          .filter(
            (entry): entry is { path?: unknown; code?: unknown } =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => ({
            path: typeof entry.path === "string" ? entry.path : "",
            code: typeof entry.code === "string" ? entry.code : "",
          }))
      : [];
    return { kind: "validation", issues };
  }
  if (!res.ok) return { kind: "error" };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { kind: "error" };
  }
  const parsed = publishResponseSchema.safeParse(body);
  return parsed.success
    ? { kind: "published", response: parsed.data }
    : { kind: "error" };
}

/** POST /v1/forms/{formId}/unpublish — the form answers `closed` afterwards. */
export async function unpublishForm(
  formId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`/v1/forms/${formId}/unpublish`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) return false;
    const parsed = unpublishResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.status === "closed";
  } catch {
    return false;
  }
}

/**
 * The public URL for a published form: `{APP_ORIGIN}/f/{slug}` — the /f/{slug}
 * SSR page (no session) is the respondent entry point.
 */
export function buildPublicUrl(appOrigin: string, slug: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/f/${slug}`;
}

/**
 * The publish-time warning condition (spec: warn when the worst-case answer
 * size, using each question kind's own cap, would exceed the submission cap).
 * The API response carries both numbers; `worstCaseBytes > submissionCapBytes`
 * is the warning.
 */
export function worstCaseExceedsCap(
  worstCaseBytes: number,
  submissionCapBytes: number,
): boolean {
  return worstCaseBytes > submissionCapBytes;
}

/** Bytes rendered as whole KB in the warning line (round UP — never understate). */
export function bytesAsKb(bytes: number): number {
  return Math.ceil(bytes / 1024);
}

/**
 * Readable message for a publish-validation issue code. Publish runs the SAME
 * shared engine as draft saves, so the codes resolve through
 * `errors.schemaIssues.*`; a code the catalog does not know (future engine
 * version) falls back to a generic line instead of throwing.
 */
export function publishIssueMessage(issue: PublishIssue): string {
  const table = en.errors.schemaIssues as Record<string, string>;
  const known = table[issue.code];
  const text = known ?? t("dashboard.publish.issueFallback");
  // issue.path is the engine's dot path ("" at the root) — show it when set.
  const shownPath = issue.path.length > 0 ? issue.path : null;
  return shownPath ? `${shownPath}: ${text}` : text;
}
