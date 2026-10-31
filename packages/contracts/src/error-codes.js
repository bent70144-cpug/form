"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCodes = void 0;
/**
 * Stable error codes (spec: "API conventions" and "Security, audit, and
 * operations"). The full M0 set is declared here so downstream tickets cannot
 * invent divergent codes; ticket 01 wires only the ones its routes use.
 */
exports.ErrorCodes = {
    validation_failed: "validation_failed",
    malformed_request: "malformed_request",
    unauthenticated: "unauthenticated",
    forbidden: "forbidden",
    email_unverified: "email_unverified",
    not_found: "not_found",
    draft_conflict: "draft_conflict",
    form_full: "form_full",
    invalid_character: "invalid_character",
    schema_too_large: "schema_too_large",
    submission_too_large: "submission_too_large",
    rate_limited: "rate_limited",
    internal_error: "internal_error",
};
//# sourceMappingURL=error-codes.js.map