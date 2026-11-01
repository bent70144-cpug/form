// Import the v3 API explicitly (see workspace.ts for the rationale).
import { z } from "zod/v3";
import { formDraftSchemaSchema } from "./form";

/**
 * Publish + public-form contracts (ticket 09).
 *
 * - `publishResponseSchema` — `POST /v1/forms/{formId}/publish` success body:
 *   the immutable version that was created, the form's public slug, and the
 *   worst-case submission size numbers the dashboard needs to render the
 *   publish-time warning (spec: "Publish warns when the worst-case answer
 *   size for a form, using each question kind's own cap, would exceed the
 *   submission cap" — `worstCaseBytes > submissionCapBytes` is the warning).
 * - `unpublishResponseSchema` — `POST /v1/forms/{formId}/unpublish` success
 *   body: the form is `closed` (republish reopens it with a new version).
 * - `publicFormResponseSchema` — `GET /v1/public/forms/{slug}` (UNauthenticated,
 *   cookie-less): discriminated by `status`. The `published` variant carries
 *   the immutable snapshot (`get_published_form(slug)` render path — never a
 *   draft); `closed` covers unpublished/soft-deleted/never-published forms;
 *   `redirect` carries the canonical slug for superseded registry entries;
 *   `not_found` maps to HTTP 404 at the API layer.
 */

export const publishResponseSchema = z
  .object({
    formId: z.string().uuid(),
    status: z.literal("published"),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    /** The form's public slug — 10-char base62 (allocated on first publish). */
    slug: z.string().regex(/^[A-Za-z0-9]{10}$/),
    /** ISO-8601 UTC timestamp of the immutable version. */
    publishedAt: z.string(),
    /** Worst-case serialized submission size at each question kind's cap. */
    worstCaseBytes: z.number().int().min(0),
    /** The submission payload cap (100 KB in M0). */
    submissionCapBytes: z.number().int().min(0),
  })
  .strict();

export type PublishResponse = z.infer<typeof publishResponseSchema>;

export const unpublishResponseSchema = z
  .object({
    formId: z.string().uuid(),
    status: z.literal("closed"),
  })
  .strict();

export type UnpublishResponse = z.infer<typeof unpublishResponseSchema>;

export const publicFormPublishedSchema = z
  .object({
    status: z.literal("published"),
    formId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().min(1),
    /** The immutable published snapshot (full envelope, never a draft). */
    schema: formDraftSchemaSchema,
  })
  .strict();

export const publicFormClosedSchema = z
  .object({ status: z.literal("closed") })
  .strict();

export const publicFormRedirectSchema = z
  .object({
    status: z.literal("redirect"),
    /** The form's current registry slug (old slugs redirect to it). */
    canonicalSlug: z.string().regex(/^[A-Za-z0-9]{10}$/),
  })
  .strict();

export const publicFormNotFoundSchema = z
  .object({ status: z.literal("not_found") })
  .strict();

export const publicFormResponseSchema = z.discriminatedUnion("status", [
  publicFormPublishedSchema,
  publicFormClosedSchema,
  publicFormRedirectSchema,
  publicFormNotFoundSchema,
]);

export type PublicFormResponse = z.infer<typeof publicFormResponseSchema>;
