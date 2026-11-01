/**
 * Stable error codes (spec: "API conventions" and "Security, audit, and
 * operations"). The full M0 set is declared here so downstream tickets cannot
 * invent divergent codes; ticket 01 wires only the ones its routes use.
 */
export const ErrorCodes = {
  validation_failed: "validation_failed",
  malformed_request: "malformed_request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  email_unverified: "email_unverified",
  origin_mismatch: "origin_mismatch",
  not_found: "not_found",
  draft_conflict: "draft_conflict",
  form_full: "form_full",
  invalid_character: "invalid_character",
  schema_too_large: "schema_too_large",
  too_many_blocks: "too_many_blocks",
  unsupported_schema_version: "unsupported_schema_version",
  submission_too_large: "submission_too_large",
  // Ticket 10 — public session/submit discriminators.
  /** 401 — the X-Form-Session header is missing on the submit route. */
  session_required: "session_required",
  /** 404 — unknown (or purged) session token hash. */
  session_not_found: "session_not_found",
  /** 410 — expired beyond the 5-minute submission grace window. */
  session_expired: "session_expired",
  /** 409 — completed session with no stored submission (data anomaly). */
  session_completed: "session_completed",
  /** 409 — unpublished, soft-deleted form, or missing pinned version. */
  form_closed: "form_closed",
  rate_limited: "rate_limited",
  internal_error: "internal_error",
} as const;

export type ErrorCode = keyof typeof ErrorCodes;
