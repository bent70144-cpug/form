/**
 * Zod definition of the stable envelope. Structural parsing only — length
 * limits, byte caps, ID format, NUL rejection and block rules are enforced in
 * `validate.ts` / `answers.ts` so every failure carries a stable error code.
 *
 * Blocks and the envelope are `.strict()`: unknown fields are rejected.
 * `settings` is deliberately permissive (the envelope reserves it; the renderer
 * ignores it in M0), and `logic` accepts rule-shaped objects only — M0 sends `[]`.
 */
import { z } from "zod";

export const blockIdSchema = z.string();

export const welcomeBlockSchema = z
  .object({
    id: blockIdSchema,
    kind: z.literal("welcome"),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const shortTextBlockSchema = z
  .object({
    id: blockIdSchema,
    kind: z.literal("short_text"),
    label: z.string(),
    description: z.string().optional(),
    required: z.boolean(),
    placeholder: z.string().optional(),
  })
  .strict();

export const longTextBlockSchema = z
  .object({
    id: blockIdSchema,
    kind: z.literal("long_text"),
    label: z.string(),
    description: z.string().optional(),
    required: z.boolean(),
    placeholder: z.string().optional(),
  })
  .strict();

export const endingBlockSchema = z
  .object({
    id: blockIdSchema,
    kind: z.literal("ending"),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("kind", [
  welcomeBlockSchema,
  shortTextBlockSchema,
  longTextBlockSchema,
  endingBlockSchema,
]);

export const themeSchema = z.object({ preset: z.literal("default") }).strict();

export const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string(),
    blocks: z.array(blockSchema),
    logic: z.array(z.record(z.unknown())),
    theme: themeSchema,
    settings: z.record(z.unknown()),
  })
  .strict();

export type ParsedEnvelope = z.infer<typeof envelopeSchema>;
