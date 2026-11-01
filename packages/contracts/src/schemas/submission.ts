// Import the v3 API explicitly (see workspace.ts for the rationale).
import { z } from "zod/v3";
import { formDraftSchemaSchema } from "./form";

/**
 * Submission inbox contracts (ticket 11) — the dashboard's per-form
 * submission list + detail. Both routes are AUTHENTICATED workspace routes
 * (`GET /v1/forms/{formId}/submissions` and
 * `GET /v1/forms/{formId}/submissions/{submissionId}`) running under the
 * FULL tenant context: RLS hides other workspaces' rows, so an unknown OR
 * cross-workspace form/submission is 404 (never 403 — no enumeration).
 *
 * - `listSubmissionsResponseSchema` — cursor pagination exactly like the
 *   forms list (default 20, max 100; `nextCursor` null on the last page).
 *   Order is newest first by `(created_at, id)` (spec API conventions).
 * - `submissionSummarySchema` — the list row: received time (`submittedAt`
 *   = `submissions.created_at`, ISO-8601 UTC), the PINNED version's number
 *   (from `form_versions.version_number` via `form_version_id`) and a small
 *   `preview` (first answer text) so the inbox renders one line without a
 *   second round trip.
 * - `submissionDetailSchema` — the detail payload: the answers object keyed
 *   by block id PLUS the PINNED version's schema envelope (`pinnedSchema`)
 *   so the UI pairs each answer with its question label from the version
 *   the respondent actually saw — never the current draft. Labels/answers
 *   render as escaped plain text client-side (React text nodes).
 */

export const submissionSummarySchema = z
  .object({
    id: z.string().uuid(),
    /** `submissions.created_at` — ISO-8601 UTC (the "received" time). */
    submittedAt: z.string(),
    /** The version this submission is pinned to (`form_versions.id`). */
    formVersionId: z.string().uuid(),
    /** `form_versions.version_number` of the pinned version. */
    formVersionNumber: z.number().int().min(1),
    /** First answer text (or null when there are no string answers). */
    preview: z.string().nullable(),
  })
  .strict();

export type SubmissionSummary = z.infer<typeof submissionSummarySchema>;

export const listSubmissionsRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListSubmissionsRequest = z.infer<typeof listSubmissionsRequestSchema>;

export const listSubmissionsResponseSchema = z.object({
  submissions: z.array(submissionSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ListSubmissionsResponse = z.infer<typeof listSubmissionsResponseSchema>;

export const submissionDetailSchema = z
  .object({
    submission: z
      .object({
        id: z.string().uuid(),
        /** ISO-8601 UTC received time. */
        submittedAt: z.string(),
        formVersion: z
          .object({
            id: z.string().uuid(),
            versionNumber: z.number().int().min(1),
          })
          .strict(),
        /** Answers keyed by block id (string values in M0). */
        answers: z.record(z.string()),
      })
      .strict(),
    /** The PINNED version's immutable schema envelope (never the draft). */
    pinnedSchema: formDraftSchemaSchema,
  })
  .strict();

export type SubmissionDetail = z.infer<typeof submissionDetailSchema>;
