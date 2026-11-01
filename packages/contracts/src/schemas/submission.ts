import { z } from "zod/v3";

/**
 * Submission contracts (ticket 11) — the dashboard inbox reads.
 *
 * A submission row stores the RAW answers keyed by block ID
 * (`submissions.answers` JSONB, ticket 10). The dashboard never reads tables:
 * the list endpoint returns one page (cursor pagination, newest first by
 * `(created_at, id)`, default 20 / max 100) and the detail endpoint pairs
 * EACH answer with the question label FROM THE PINNED VERSION's schema
 * (`form_versions.schema` — never the mutable draft) plus the received time
 * and the form version number.
 *
 * Labels and answers travel as PLAIN TEXT strings; the web app renders them
 * escaped (React text nodes) — the server does no HTML work.
 */

/** One page of the per-form inbox (GET /v1/forms/{formId}/submissions). */
export const listSubmissionsRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListSubmissionsRequest = z.infer<typeof listSubmissionsRequestSchema>;

/** One inbox list row: received time + the version the respondent saw. */
export const submissionSummarySchema = z.object({
  id: z.string().uuid(),
  /** ISO-8601 UTC — `submissions.created_at` (the received time). */
  createdAt: z.string(),
  /** `form_versions.version_number` of the submission's pinned version. */
  formVersionNumber: z.number().int().min(1),
});

export type SubmissionSummary = z.infer<typeof submissionSummarySchema>;

export const listSubmissionsResponseSchema = z.object({
  submissions: z.array(submissionSummarySchema),
  /** Opaque cursor; null on the last page. */
  nextCursor: z.string().nullable(),
});

export type ListSubmissionsResponse = z.infer<typeof listSubmissionsResponseSchema>;

/**
 * One answer-beside-question pair. `label` comes from the PINNED version's
 * schema and is null only when the stored block id has no matching question
 * block (defensive — the pinned version is immutable so this cannot happen
 * through the public flow). `answer` is the raw stored text.
 */
export const submissionAnswerPairSchema = z.object({
  blockId: z.string(),
  label: z.string().nullable(),
  answer: z.string(),
});

export type SubmissionAnswerPair = z.infer<typeof submissionAnswerPairSchema>;

/** GET /v1/forms/{formId}/submissions/{submissionId} — the detail view. */
export const submissionDetailSchema = z.object({
  id: z.string().uuid(),
  /** ISO-8601 UTC received time. */
  createdAt: z.string(),
  /** `form_versions.version_number` of the pinned version (the badge). */
  formVersionNumber: z.number().int().min(1),
  /** Answers in the pinned schema's block order, each with its question label. */
  answers: z.array(submissionAnswerPairSchema),
});

export type SubmissionDetail = z.infer<typeof submissionDetailSchema>;
