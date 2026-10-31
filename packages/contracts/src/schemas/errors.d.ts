import { z } from "zod/v3";
/**
 * RFC 9457 Problem Details with a stable `code` and optional field errors
 * (spec: "Errors use RFC 9457 Problem Details with a stable `code` and
 * optional field errors").
 */
export declare const fieldErrorSchema: z.ZodObject<{
    path: z.ZodString;
    code: z.ZodString;
    message: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
    path: string;
    message: string;
}, {
    code: string;
    path: string;
    message: string;
}>;
export declare const problemDetailsSchema: z.ZodObject<{
    type: z.ZodString;
    title: z.ZodString;
    status: z.ZodNumber;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    errors: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        code: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        path: string;
        message: string;
    }, {
        code: string;
        path: string;
        message: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    status: number;
    code: string;
    type: string;
    title: string;
    detail?: string | undefined;
    errors?: {
        code: string;
        path: string;
        message: string;
    }[] | undefined;
}, {
    status: number;
    code: string;
    type: string;
    title: string;
    detail?: string | undefined;
    errors?: {
        code: string;
        path: string;
        message: string;
    }[] | undefined;
}>;
export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
/** Builds the `type` URI for a problem (stable per error slug). */
export declare function problemType(slug: string): string;
//# sourceMappingURL=errors.d.ts.map