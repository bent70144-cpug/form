import { cache } from "react";
import { cookies } from "next/headers";
import {
  listSubmissionsResponseSchema,
  submissionDetailSchema,
  type ListSubmissionsResponse,
  type SubmissionDetail,
} from "@form/contracts";
import { internalApiUrl } from "./internal-api";

/**
 * Server-component readers for the submission inbox (ticket 11) — the same
 * shape as lib/forms.ts: read-only GETs run SERVER-SIDE against the INTERNAL
 * API URL with the incoming cookie forwarded, responses are parsed through
 * the shared contracts so drift fails loudly, and each reader is wrapped in
 * React cache() so one render shares one HTTP call.
 *
 * null means "not found OR unreachable": the list page distinguishes via the
 * form read (getForm) whether the form itself is foreign/unknown (404 →
 * notFound()) and otherwise renders the load-failed state; the detail page
 * maps any null to notFound() — the API's 404 already covers unknown,
 * cross-form and cross-workspace submissions identically.
 */

async function apiGet(
  path: string,
  cookieHeader: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${internalApiUrl()}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    // Never cache tenant dashboards (spec's no-store posture).
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** The incoming request's cookie header (forwarded to the internal API). */
const getCookieHeader = cache(async (): Promise<string> => {
  const cookieStore = await cookies();
  return cookieStore.toString();
});

/**
 * GET /v1/forms/{formId}/submissions — one inbox page (newest first by
 * (created_at, id); default limit 20, `cursor` for the next page). null when
 * the response is not a valid page (404 / network / drift).
 */
export const listSubmissions = cache(
  async (
    formId: string,
    cursor?: string,
  ): Promise<ListSubmissionsResponse | null> => {
    const cookieHeader = await getCookieHeader();
    const query =
      cursor !== undefined
        ? `?cursor=${encodeURIComponent(cursor)}`
        : "";
    const { status, body } = await apiGet(
      `/v1/forms/${formId}/submissions${query}`,
      cookieHeader,
    );
    if (status !== 200) return null;
    const parsed = listSubmissionsResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  },
);

/**
 * GET /v1/forms/{formId}/submissions/{submissionId} — the detail view with
 * the pinned-version answer/label pairs. null on any failure (the page
 * renders not-found; the API never distinguishes cross-tenant from missing).
 */
export const getSubmission = cache(
  async (
    formId: string,
    submissionId: string,
  ): Promise<SubmissionDetail | null> => {
    const cookieHeader = await getCookieHeader();
    const { status, body } = await apiGet(
      `/v1/forms/${formId}/submissions/${submissionId}`,
      cookieHeader,
    );
    if (status !== 200) return null;
    const parsed = submissionDetailSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  },
);

/**
 * Deterministic received-time rendering (i18n `dashboard.inbox.receivedAt`
 * interpolates the result). The API returns ISO-8601 UTC; the inbox shows
 * `YYYY-MM-DD HH:MM UTC` — stable across server/client so hydration never
 * mismatches. Non-ISO input falls back to the raw string.
 */
export function formatReceivedAt(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
