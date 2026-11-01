import { z } from "zod/v3";

/**
 * Form contracts (ticket 06) — create / list / read / rename.
 *
 * The draft `schema` JSONB is validated LOOSELY here: the stable envelope keys
 * must be present with the right primitive shapes, but unknown keys pass and
 * block contents are not inspected. Strict publish/save validation lives in
 * @form/form-schema and is wired to the API in ticket 07; until then the API
 * only ever stores `emptyDraft()` verbatim.
 *
 * `forms.name` is the DASHBOARD label and is not respondent-facing (spec:
 * "Respondents see the pinned schema's `title`, not `forms.name`"). Renaming
 * through the dashboard therefore touches only `forms.name`.
 */

export const formStatusSchema = z.enum(["draft", "published", "closed"]);

/**
 * Loose passthrough of the stable schema envelope (`schemaVersion`, `title`,
 * `blocks`, `logic`, `theme`, `settings`). Unknown keys pass through; strict
 * validation is ticket 07's job.
 */
export const draftSchemaLooseSchema = z
  .object({
    schemaVersion: z.number(),
    title: z.string(),
    blocks: z.array(z.unknown()),
    logic: z.array(z.unknown()),
    theme: z.record(z.unknown()),
    settings: z.record(z.unknown()),
  })
  .passthrough();

/** One mutable draft row, as returned by the API. */
export const formDraftEnvelopeSchema = z.object({
  draftVersion: z.number().int().min(0),
  schema: draftSchemaLooseSchema,
  updatedAt: z.string().min(1),
});

/** The form row as the dashboard sees it (summary — no schema payload). */
export const formSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  status: formStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/** Dashboard label on create/rename. Not the respondent-facing title. */
export const formNameSchema = z.string().min(1).max(200);

export const createFormRequestSchema = z.object({
  name: formNameSchema,
});

export const renameFormRequestSchema = z.object({
  name: formNameSchema,
});

/** `POST /v1/forms` and `GET /v1/forms/{id}` — the form plus its draft. */
export const formDetailResponseSchema = z.object({
  form: formSummarySchema,
  draft: formDraftEnvelopeSchema,
});

/** `PATCH /v1/forms/{id}` — the renamed form summary. */
export const formRenameResponseSchema = z.object({
  form: formSummarySchema,
});

/** `GET /v1/forms` — newest-first `(created_at, id)` cursor page. */
export const formListResponseSchema = z.object({
  forms: z.array(formSummarySchema),
  nextCursor: z.string().nullable(),
});

export type FormStatus = z.infer<typeof formStatusSchema>;
export type FormSummary = z.infer<typeof formSummarySchema>;
export type FormDraftEnvelope = z.infer<typeof formDraftEnvelopeSchema>;
export type FormDetailResponse = z.infer<typeof formDetailResponseSchema>;
export type FormListResponse = z.infer<typeof formListResponseSchema>;
