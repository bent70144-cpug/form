// Import the v3 API explicitly (see workspace.ts for the rationale).
import { z } from "zod/v3";

/**
 * Form contracts (ticket 06). A form row is the DASHBOARD identity
 * (`forms.name` is the label users see in lists — never respondent-facing);
 * the respondent-facing title lives in the draft schema envelope (`title`),
 * which is edited by the builder (ticket 08) and pinned on publish (T09).
 *
 * The draft envelope mirrors `@form/form-schema`'s stable envelope — the M0
 * block union only. It is re-declared here (not imported) so the OpenAPI
 * document stays generated from the wire contracts alone and the contracts
 * package keeps no runtime dependency on the schema engine. T07's draft-save
 * validation uses the stricter form-schema schemas; these DTOs only pin the
 * wire shape (GET /v1/forms/{id} already returns the envelope that T07's
 * PUT will replace).
 */
export const formBlockIdSchema = z.string();

export const welcomeBlockDtoSchema = z
  .object({
    id: formBlockIdSchema,
    kind: z.literal("welcome"),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const shortTextBlockDtoSchema = z
  .object({
    id: formBlockIdSchema,
    kind: z.literal("short_text"),
    label: z.string(),
    description: z.string().optional(),
    required: z.boolean(),
    placeholder: z.string().optional(),
  })
  .strict();

export const longTextBlockDtoSchema = z
  .object({
    id: formBlockIdSchema,
    kind: z.literal("long_text"),
    label: z.string(),
    description: z.string().optional(),
    required: z.boolean(),
    placeholder: z.string().optional(),
  })
  .strict();

export const endingBlockDtoSchema = z
  .object({
    id: formBlockIdSchema,
    kind: z.literal("ending"),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const formBlockDtoSchema = z.discriminatedUnion("kind", [
  welcomeBlockDtoSchema,
  shortTextBlockDtoSchema,
  longTextBlockDtoSchema,
  endingBlockDtoSchema,
]);

/** The draft schema envelope as stored in `form_drafts.schema`. */
export const formDraftSchemaSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string(),
    blocks: z.array(formBlockDtoSchema),
    logic: z.array(z.record(z.unknown())),
    theme: z.object({ preset: z.literal("default") }).strict(),
    settings: z.record(z.unknown()),
  })
  .strict();

export type FormDraftSchema = z.infer<typeof formDraftSchemaSchema>;

/**
 * Form summary — the list row. `createdAt`/`updatedAt` are ISO-8601 UTC.
 */
export const formSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  status: z.enum(["draft", "published", "closed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FormSummary = z.infer<typeof formSummarySchema>;

/**
 * Form detail — form + its mutable draft (the shape the form-page shell
 * renders and the T07 draft PUT will target for saves).
 */
export const formDetailSchema = formSummarySchema.extend({
  projectId: z.string().uuid(),
  draft: z.object({
    draftVersion: z.number().int().min(0),
    schema: formDraftSchemaSchema,
  }),
});

export type FormDetail = z.infer<typeof formDetailSchema>;

/**
 * `POST /v1/forms` — creates the form in the ACTIVE workspace (resolved
 * server-side) under the DEFAULT PROJECT (found via `projects.is_default`,
 * never by name). The request body is optional; an absent `name` falls back
 * to the i18n default dashboard label.
 */
export const createFormRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateFormRequest = z.infer<typeof createFormRequestSchema>;

export const createFormResponseSchema = formDetailSchema;

/**
 * `GET /v1/forms` — cursor pagination (spec: default page size 20, max 100),
 * newest first by `(created_at, id)`. `nextCursor` is null on the last page;
 * the cursor is an opaque string.
 */
export const listFormsRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListFormsRequest = z.infer<typeof listFormsRequestSchema>;

export const listFormsResponseSchema = z.object({
  forms: z.array(formSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ListFormsResponse = z.infer<typeof listFormsResponseSchema>;

/**
 * `PATCH /v1/forms/{id}/name` — renames the DASHBOARD label only
 * (`forms.name`); the respondent-facing title in the draft envelope is
 * untouched. 404 when the form does not exist in the active workspace
 * (cross-tenant access is never distinguished from a missing row).
 */
export const renameFormRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
  })
  .strict();

export type RenameFormRequest = z.infer<typeof renameFormRequestSchema>;

export const renameFormResponseSchema = formSummarySchema;
