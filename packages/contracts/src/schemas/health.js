"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthResponseSchema = void 0;
// Import the v3 API explicitly: zod 3.25 ships v3+v4 in one package and
// zod-to-json-schema is typed against `zod/v3`. Mixing the root re-export with
// `zod/v3` types triggers a TS2589 instantiation explosion (OOM-scale check).
const v3_1 = require("zod/v3");
/**
 * Liveness + database reachability (spec: "A health endpoint reports process
 * liveness and database reachability without exposing tenant data").
 */
exports.healthResponseSchema = v3_1.z.object({
    status: v3_1.z.literal("ok"),
    db: v3_1.z.boolean(),
});
//# sourceMappingURL=health.js.map