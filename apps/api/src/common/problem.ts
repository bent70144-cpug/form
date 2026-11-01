import type { Response } from "express";
import { problemType, type ErrorCode } from "@form/contracts";
import { t } from "@form/i18n";

/**
 * RFC 9457 Problem Details writer. Titles/details are resolved from the i18n
 * catalog by stable keys (spec guardrail: "API error codes are stable and
 * human-readable messages come from i18n keys") — never hardcoded strings.
 */
export const PROBLEM_TITLE_KEYS: Partial<Record<ErrorCode, `errors.${string}.title`>> = {
  validation_failed: "errors.validation.title",
  malformed_request: "errors.malformed.title",
  unauthenticated: "errors.unauthenticated.title",
  forbidden: "errors.forbidden.title",
  email_unverified: "errors.emailUnverified.title",
  not_found: "errors.notFound.title",
  draft_conflict: "errors.conflict.title",
  form_full: "errors.conflict.title",
  rate_limited: "errors.rateLimited.title",
  origin_mismatch: "errors.originMismatch.title",
  internal_error: "errors.internal.title",
  // Ticket 10 — public session/submit discriminators.
  session_required: "errors.sessionRequired.title",
  session_not_found: "errors.sessionNotFound.title",
  session_expired: "errors.sessionExpired.title",
  session_completed: "errors.sessionCompleted.title",
  form_closed: "errors.formClosed.title",
};

/** i18n keys carrying optional extra detail for specific codes. */
export const PROBLEM_DETAIL_KEYS: Partial<Record<ErrorCode, string>> = {
  email_unverified: "errors.emailUnverified.detail",
  origin_mismatch: "errors.originMismatch.detail",
  session_required: "errors.sessionRequired.detail",
  session_not_found: "errors.sessionNotFound.detail",
  session_expired: "errors.sessionExpired.detail",
  session_completed: "errors.sessionCompleted.detail",
  form_closed: "errors.formClosed.detail",
};

export function sendProblem(
  res: Response,
  status: number,
  code: ErrorCode,
  overrides: { detail?: string; errors?: Array<{ path: string; code: string; message: string }> } = {},
): void {
  const titleKey = PROBLEM_TITLE_KEYS[code] ?? "errors.internal.title";
  const detailKey = PROBLEM_DETAIL_KEYS[code];
  res.status(status).type("application/problem+json").json({
    type: problemType(code),
    title: t(titleKey as never),
    status,
    code,
    ...(detailKey ? { detail: t(detailKey as never) } : {}),
    ...overrides,
  });
}
