/**
 * Stable error codes (spec: "API conventions" and "Security, audit, and
 * operations"). The full M0 set is declared here so downstream tickets cannot
 * invent divergent codes; ticket 01 wires only the ones its routes use.
 */
export declare const ErrorCodes: {
    readonly validation_failed: "validation_failed";
    readonly malformed_request: "malformed_request";
    readonly unauthenticated: "unauthenticated";
    readonly forbidden: "forbidden";
    readonly email_unverified: "email_unverified";
    readonly not_found: "not_found";
    readonly draft_conflict: "draft_conflict";
    readonly form_full: "form_full";
    readonly invalid_character: "invalid_character";
    readonly schema_too_large: "schema_too_large";
    readonly submission_too_large: "submission_too_large";
    readonly rate_limited: "rate_limited";
    readonly internal_error: "internal_error";
};
export type ErrorCode = keyof typeof ErrorCodes;
//# sourceMappingURL=error-codes.d.ts.map