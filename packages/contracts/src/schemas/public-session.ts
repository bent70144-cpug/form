// Import the v3 API explicitly (see workspace.ts for the rationale).
import { z } from "zod/v3";
import { formDraftSchemaSchema } from "./form";

/**
 * Public session + submission contracts (ticket 10) — the interactive public
 * form. Both routes are UNauthenticated and cookie-less (spec: "M0 does not
 * depend on third-party cookies, so the flow remains embeddable later").
 *
 * - `sessionCreateResponseSchema` — `POST /v1/public/forms/{slug}/sessions`
 *   success body. The RAW session token appears here and ONLY here (the API
 *   stores its SHA-256 hash); the session pins the currently published
 *   version for 24 hours. `expiresAt` is ISO-8601 UTC.
 * - `submitRequestSchema` — `POST /v1/public/submissions` body, sent with the
 *   raw token in the `X-Form-Session` header. Answers are keyed by block id;
 *   the SERVER validates against the pinned schema (the contract only fixes
 *   the envelope shape — values are strings in M0 but the stable error codes
 *   cover non-string values too).
 * - `submitReceiptSchema` — the idempotent receipt: `submitted: true` plus
 *   the submission id. Stored answers are NEVER returned (spec: "A retry
 *   returns a receipt without stored answers").
 *
 * Error discriminators for the route (RFC 9457 problem `code` values, see
 * `ErrorCodes`): `session_required` (401, missing X-Form-Session),
 * `session_not_found` (404, unknown/expunged token), `session_expired`
 * (410, expired beyond the 5-minute grace), `session_completed` (409,
 * completed session without a stored submission), `form_closed` (409,
 * unpublished/soft-deleted form or missing pinned version), `form_full`
 * (409, per-form submission cap reached), `rate_limited` (429) and the
 * 422 `validation_failed` field errors carrying the schema engine's stable
 * per-answer codes.
 */

export const sessionCreateResponseSchema = z
  .object({
    /** The raw session token (base64url of 32 random bytes) — returned ONCE. */
    token: z.string().min(16),
    /** ISO-8601 UTC — now + 24h at creation. */
    expiresAt: z.string(),
    /** The published version the session is PINNED to (form_versions.id). */
    pinnedVersionId: z.string().uuid(),
    /** The pinned published snapshot (immutable — never a draft). */
    schema: formDraftSchemaSchema,
  })
  .strict();

export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;

export const submitRequestSchema = z
  .object({
    /** Answers keyed by block id (string values in M0; server-validated). */
    answers: z.record(z.unknown()),
  })
  .strict();

export type SubmitRequest = z.infer<typeof submitRequestSchema>;

export const submitReceiptSchema = z
  .object({
    submitted: z.literal(true),
    submissionId: z.string().uuid(),
  })
  .strict();

export type SubmitReceipt = z.infer<typeof submitReceiptSchema>;
