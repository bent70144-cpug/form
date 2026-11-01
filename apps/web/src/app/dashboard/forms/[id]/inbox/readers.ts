import { cache } from "react";
import { cookies } from "next/headers";
import {
  listSubmissionsResponseSchema,
  submissionDetailSchema,
  type ListSubmissionsResponse,
  type SubmissionDetail,
} from "@form/contracts";
import { internalApiUrl } from "../../../../../lib/internal-api";

/**
 * Server-component readers for the inbox slices (ticket 11) — the same shape
 * as lib/forms.ts: GETs are read-only and therefore run SERVER-SIDE against
 * the INTERNAL API URL with the incoming cookie forwarded (the Origin guard
 * only shields state-changing methods; the inbox is pure reads).
 *
 * Responses are parsed through the shared contracts so drift fails loudly.
 * A null return means "cannot render this view": for listSubmissions after
 * the form itself was already read (existence proven) it is a load failure
 * (rendered as the i18n error state, never a crash); getSubmissionDetail
 * null covers 404 — unknown id OR another workspace's submission, which the
 * API deliberately cannot distinguish (no enumeration).
 *
 * Each reader is wrapped in React cache() so one render shares one HTTP call.
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
 * GET /v1/forms/{formId}/submissions — one page (default limit 20) of the
 * form's submissions, newest first. Optional opaque `cursor` for page 2+.
 */
export const listSubmissions = cache(
  async (
    formId: string,
    cursor?: string,
  ): Promise<ListSubmissionsResponse | null> => {
    const cookieHeader = await getCookieHeader();
    const query = cursor
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
 * GET /v1/forms/{formId}/submissions/{submissionId} — answers + the PINNED
 * version's schema. null on 404 (unknown id, another form's submission, or
 * cross-workspace — all 404 by design, no enumeration).
 */
export const getSubmissionDetail = cache(
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
