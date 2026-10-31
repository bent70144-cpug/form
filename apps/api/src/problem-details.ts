import { problemDetailsSchema, problemType, ErrorCodes, type ProblemDetails } from "@form/contracts";
import { t } from "@form/i18n";
import type { ErrorCode } from "@form/contracts";

/**
 * RFC 9457 Problem Details filter (spec: "Errors use RFC 9457 Problem
 * Details with a stable `code`"). API handlers throw `ProblemHttpError`;
 * the request dispatcher renders every error through this module so bodies
 * cannot drift from the shared contract.
 */

/** Maps stable error codes to their i18n title keys (never hardcoded strings). */
const TITLE_KEYS: Record<ErrorCode, Parameters<typeof t>[0]> = {
  validation_failed: "errors.validation.title",
  malformed_request: "errors.malformed.title",
  unauthenticated: "errors.unauthenticated.title",
  forbidden: "errors.forbidden.title",
  email_unverified: "errors.unauthenticated.title",
  not_found: "errors.notFound.title",
  draft_conflict: "errors.conflict.title",
  form_full: "errors.conflict.title",
  invalid_character: "errors.validation.title",
  schema_too_large: "errors.validation.title",
  submission_too_large: "errors.validation.title",
  rate_limited: "errors.rateLimited.title",
  internal_error: "errors.internal.title",
};

/** HTTP status for a stable error code (spec conventions). */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 422,
  malformed_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  email_unverified: 403,
  not_found: 404,
  draft_conflict: 409,
  form_full: 409,
  invalid_character: 422,
  schema_too_large: 422,
  submission_too_large: 422,
  rate_limited: 429,
  internal_error: 500,
};

export class ProblemHttpError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "ProblemHttpError";
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function problemFromError(
  error: unknown,
): { status: number; body: ProblemDetails } {
  if (error instanceof ProblemHttpError) {
    return {
      status: error.status,
      body: {
        type: problemType(error.code),
        title: t(TITLE_KEYS[error.code]),
        status: error.status,
        code: error.code,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    };
  }
  return {
    status: 500,
    body: {
      type: problemType(ErrorCodes.internal_error),
      title: t("errors.internal.title"),
      status: 500,
      code: ErrorCodes.internal_error,
    },
  };
}

/** Parse-safe guard used by the dispatcher (validated shape per contract). */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  return problemDetailsSchema.safeParse(value).success;
}
