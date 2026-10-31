"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.problemDetailsSchema = exports.fieldErrorSchema = void 0;
exports.problemType = problemType;
const v3_1 = require("zod/v3");
/**
 * RFC 9457 Problem Details with a stable `code` and optional field errors
 * (spec: "Errors use RFC 9457 Problem Details with a stable `code` and
 * optional field errors").
 */
exports.fieldErrorSchema = v3_1.z.object({
    path: v3_1.z.string(),
    code: v3_1.z.string(),
    message: v3_1.z.string(),
});
exports.problemDetailsSchema = v3_1.z.object({
    type: v3_1.z.string(),
    title: v3_1.z.string(),
    status: v3_1.z.number().int(),
    code: v3_1.z.string(),
    detail: v3_1.z.string().optional(),
    errors: v3_1.z.array(exports.fieldErrorSchema).optional(),
});
/** Builds the `type` URI for a problem (stable per error slug). */
function problemType(slug) {
    return `https://form.example/errors/${slug}`;
}
//# sourceMappingURL=errors.js.map