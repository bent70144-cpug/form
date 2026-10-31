import { z } from "zod/v3";

/**
 * RFC 9457 Problem Details with a stable `code` and optional field errors
 * (spec: "Errors use RFC 9457 Problem Details with a stable `code` and
 * optional field errors").
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  errors: z.array(fieldErrorSchema).optional(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/** Builds the `type` URI for a problem (stable per error slug). */
export function problemType(slug: string): string {
  return `https://form.example/errors/${slug}`;
}
