import { cache } from "react";
import { cookies } from "next/headers";
import {
  formDetailSchema,
  listFormsResponseSchema,
  type FormDetail,
  type ListFormsResponse,
} from "@form/contracts";
import { internalApiUrl } from "./internal-api";

/**
 * Server-component readers for the dashboard's form slices (ticket 06).
 *
 * GETs are read-only and therefore run SERVER-SIDE against the INTERNAL API
 * URL with the incoming cookie forwarded — the same shape as
 * getServerSession() (the Origin guard only shields state-changing methods;
 * mutations always run in the browser through the same-origin /v1/* rewrite,
 * see lib/forms-client.ts + NewFormButton/RenameForm).
 *
 * Responses are parsed through the shared contracts so drift fails loudly.
 * A 404 (unknown id OR another workspace's form — never distinguishable)
 * maps to null, which the form page turns into notFound().
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

/** GET /v1/forms — one page (default limit) of the active workspace's forms. */
export const listForms = cache(async (): Promise<ListFormsResponse | null> => {
  const cookieHeader = await getCookieHeader();
  const { status, body } = await apiGet("/v1/forms", cookieHeader);
  if (status !== 200) return null;
  const parsed = listFormsResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
});

/**
 * GET /v1/forms/{formId} — form + draft. null on 404 (unknown or
 * cross-workspace — both 404 by design, no enumeration).
 */
export const getForm = cache(
  async (formId: string): Promise<FormDetail | null> => {
    const cookieHeader = await getCookieHeader();
    const { status, body } = await apiGet(`/v1/forms/${formId}`, cookieHeader);
    if (status !== 200) return null;
    const parsed = formDetailSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  },
);
