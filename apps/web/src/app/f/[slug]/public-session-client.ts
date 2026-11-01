import {
  problemDetailsSchema,
  sessionCreateResponseSchema,
  submitReceiptSchema,
  type ProblemDetails,
  type SessionCreateResponse,
  type SubmitReceipt,
} from "@form/contracts";

/**
 * Browser-side client for the INTERACTIVE public form (ticket 10). Unlike the
 * SSR reader (public-api-client.ts, internal API URL, server-only), these
 * calls run IN the browser through the same-origin Next.js `/v1/*` rewrite:
 *
 * - `POST /v1/public/forms/{slug}/sessions` — creates the pinned session; the
 *   raw token comes back ONCE and is kept in sessionStorage (spec: "The
 *   client keeps it in memory or session storage and sends it as
 *   X-Form-Session; M0 does not depend on third-party cookies").
 * - `POST /v1/public/submissions` — submits the answers with the
 *   `X-Form-Session` header. Both routes are cookie-less (no credentials):
 *   nothing here reads or sends the auth cookie.
 *
 * Responses are parsed through the shared contracts; anything unparseable
 * maps to a failure result (never a thrown network error reaching the UI).
 */

export type CreateSessionResult =
  | { ok: true; session: SessionCreateResponse }
  | { ok: false; status: number };

export type SubmitAnswersResult =
  | { ok: true; receipt: SubmitReceipt }
  | { ok: false; status: number; problem: ProblemDetails | null };

export async function createPublicSession(
  slug: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CreateSessionResult> {
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/v1/public/forms/${encodeURIComponent(slug)}/sessions`, {
      method: "POST",
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (res.status !== 200) return { ok: false, status: res.status };

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, status: res.status };
  }
  const parsed = sessionCreateResponseSchema.safeParse(body);
  return parsed.success
    ? { ok: true, session: parsed.data }
    : { ok: false, status: res.status };
}

export async function submitPublicAnswers(
  token: string,
  answers: Record<string, string>,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SubmitAnswersResult> {
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch("/v1/public/submissions", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-form-session": token,
      },
      body: JSON.stringify({ answers }),
    });
  } catch {
    return { ok: false, status: 0, problem: null };
  }

  if (res.status === 200) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: res.status, problem: null };
    }
    const parsed = submitReceiptSchema.safeParse(body);
    return parsed.success
      ? { ok: true, receipt: parsed.data }
      : { ok: false, status: res.status, problem: null };
  }

  let problem: ProblemDetails | null = null;
  try {
    const body: unknown = await res.json();
    const parsed = problemDetailsSchema.safeParse(body);
    if (parsed.success) problem = parsed.data;
  } catch {
    problem = null;
  }
  return { ok: false, status: res.status, problem };
}

/** sessionStorage key for the raw token of one slug's pinned session. */
export function sessionTokenStorageKey(slug: string): string {
  return `form-session:${slug}`;
}
